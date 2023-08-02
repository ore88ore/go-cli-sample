import {
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_ecs as ecs,
  aws_iam as iam,
  aws_scheduler as scheduler,
  aws_sqs as sqs,
  aws_stepfunctions as sfn,
  aws_stepfunctions_tasks as tasks,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { TaskInput } from "aws-cdk-lib/aws-stepfunctions";

export class CdkStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // VPC
    const vpc = new ec2.Vpc(this, "Vpc", { maxAzs: 2, natGateways: 1 });
    // セキュリティグループを渡せば、リソース数を減らせる
    const runTaskSecurityGroup = new ec2.SecurityGroup(
      this,
      "runTaskSecurityGroup",
      { vpc, allowAllOutbound: true },
    );

    // ECS
    const cluster = new ecs.Cluster(this, "cluster", { vpc });
    const taskDefinition = new ecs.FargateTaskDefinition(
      this,
      "taskDefinition",
      {
        cpu: 512,
        memoryLimitMiB: 1024,
      },
    );
    const goBatchContainer = taskDefinition.addContainer("goBatchContainer", {
      image: ecs.ContainerImage.fromEcrRepository(
        ecr.Repository.fromRepositoryName(
          this,
          "ecrRepository",
          "yus_sakai_test",
        ),
      ),
      environment: {
        ENV: "Original env value.",
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "batch-log-",
      }),
    });

    const containerOverrides1: tasks.ContainerOverride[] = [
      {
        containerDefinition: goBatchContainer,
        command: sfn.JsonPath.listAt("$.commands"),
        environment: [{ name: "ENV", value: sfn.JsonPath.stringAt("$.env") }],
      },
    ];
    const containerOverrides2: tasks.ContainerOverride[] = [
      {
        containerDefinition: goBatchContainer,
        command: sfn.JsonPath.listAt("$.commands"),
        environment: [{ name: "ENV", value: "From step functions2." }],
      },
    ];
    const ecsRunTask1 = new tasks.EcsRunTask(this, "ecsRunTask1", {
      integrationPattern: sfn.IntegrationPattern.RUN_JOB,
      cluster,
      taskDefinition,
      containerOverrides: containerOverrides1,
      launchTarget: new tasks.EcsFargateLaunchTarget(),
      securityGroups: [runTaskSecurityGroup],
    });
    const ecsRunTask2 = new tasks.EcsRunTask(this, "ecsRunTask2", {
      integrationPattern: sfn.IntegrationPattern.RUN_JOB,
      cluster,
      taskDefinition,
      containerOverrides: containerOverrides2,
      launchTarget: new tasks.EcsFargateLaunchTarget(),
      securityGroups: [runTaskSecurityGroup],
    });

    // see: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_stepfunctions-readme.html
    const execEcsRunStateMachine1 = new sfn.StateMachine(
      this,
      "execEcsRunStateMachine1",
      {
        stateMachineName: "execEcsRunStateMachine1",
        definitionBody: sfn.DefinitionBody.fromChainable(ecsRunTask1),
      },
    );
    const execEcsRunStateMachine2 = new sfn.StateMachine(
      this,
      "execEcsRunStateMachine2",
      {
        stateMachineName: "execEcsRunStateMachine2",
        definitionBody: sfn.DefinitionBody.fromChainable(ecsRunTask2),
      },
    );

    // see: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_stepfunctions_tasks-readme.html#step-functions
    const stepFunctionsRunTask = new tasks.StepFunctionsStartExecution(
      this,
      "stepFunctionsRunTask1",
      {
        stateMachine: execEcsRunStateMachine1,
        integrationPattern: sfn.IntegrationPattern.RUN_JOB,
        input: TaskInput.fromObject({
          commands: ["from1", "object1"],
          env: "Start Execution input1",
        }),
      },
    ).next(
      new tasks.StepFunctionsStartExecution(this, "stepFunctionsRunTask2", {
        stateMachine: execEcsRunStateMachine2,
        integrationPattern: sfn.IntegrationPattern.RUN_JOB,
        input: TaskInput.fromObject({
          commands: ["from2", "object2"],
          env: "Start Execution input2",
        }),
      }),
    );

    const execStepFunctionsStateMachine = new sfn.StateMachine(
      this,
      "execStepFunctionsStateMachine",
      {
        stateMachineName: "execStepFunctionsStateMachine",
        definitionBody: sfn.DefinitionBody.fromChainable(stepFunctionsRunTask),
      },
    );

    // see: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_iam-readme.html
    const eventSchedulerRole = new iam.Role(this, "eventSchedulerRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
    });
    eventSchedulerRole.addToPolicy(
      new iam.PolicyStatement({
        resources: ["*"],
        actions: ["states:StartExecution"],
      }),
    );

    const eventSchedulerDlq = new sqs.Queue(this, "EventSchedulerDlq", {
      queueName: "event-scheduler-dlq",
      encryption: sqs.QueueEncryption.KMS_MANAGED,
    });
    eventSchedulerDlq.grantSendMessages(eventSchedulerRole);

    // see: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_scheduler-readme.html
    // see: https://docs.aws.amazon.com/ja_jp/AWSCloudFormation/latest/UserGuide/aws-resource-scheduler-schedule.html
    new scheduler.CfnSchedule(this, `execStepFunctionsSchedule`, {
      scheduleExpression: "cron(0 10 * * ? *)",
      scheduleExpressionTimezone: "Asia/Tokyo",
      flexibleTimeWindow: { mode: "OFF" },
      state: "DISABLED",
      target: {
        arn: execStepFunctionsStateMachine.stateMachineArn,
        roleArn: eventSchedulerRole.roleArn,
        // see: https://docs.aws.amazon.com/ja_jp/eventbridge/latest/userguide/eb-rule-dlq.html
        retryPolicy: {
          maximumRetryAttempts: 0,
        },
        deadLetterConfig: {
          arn: eventSchedulerDlq.queueArn,
        },
      },
      groupName: "default",
    });
  }
}
