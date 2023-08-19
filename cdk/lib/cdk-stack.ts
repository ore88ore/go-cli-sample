import {
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_ecs as ecs,
  aws_s3 as s3,
  aws_stepfunctions as sfn,
  aws_stepfunctions_tasks as tasks,
  aws_events as events,
  aws_events_targets as events_targets,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import { Construct } from "constructs";

export class CdkStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const ecrRepository = process.env.ECR_REPOSITORY ?? "";
    const bucketName = process.env.BUCKET_NAME ?? "";
    if (ecrRepository === "" || bucketName === "") {
      throw new Error(
        "環境変数 ECR_REPOSITORY または BUCKET_NAME が設定されていない",
      );
    }

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
        ecr.Repository.fromRepositoryName(this, "ecrRepository", ecrRepository),
      ),
      environment: {
        ENV: "Original env value.",
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "batch-log-",
      }),
    });

    const containerOverrides: tasks.ContainerOverride[] = [
      {
        containerDefinition: goBatchContainer,
        command: sfn.JsonPath.array(
          sfn.JsonPath.stringAt("$.detail.object.key"),
        ) as any,
      },
    ];

    const ecsRunTask = new tasks.EcsRunTask(this, "ecsRunTask", {
      integrationPattern: sfn.IntegrationPattern.RUN_JOB,
      cluster,
      taskDefinition,
      containerOverrides: containerOverrides,
      launchTarget: new tasks.EcsFargateLaunchTarget(),
      securityGroups: [runTaskSecurityGroup],
    });

    // see: https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_stepfunctions-readme.html
    const execEcsRunStateMachine = new sfn.StateMachine(
      this,
      "execEcsRunStateMachine",
      {
        stateMachineName: "execEcsRunStateMachine",
        definitionBody: sfn.DefinitionBody.fromChainable(ecsRunTask),
      },
    );

    const bucket = new s3.Bucket(this, "eventBucket", {
      bucketName: `${this.account}-${bucketName}`,
      eventBridgeEnabled: true,
    });

    new events.Rule(this, "S3EventRule", {
      eventPattern: {
        source: ["aws.s3"],
        account: [this.account],
        region: [this.region],
        detailType: events.Match.equalsIgnoreCase("object created"),
        detail: {
          bucket: {
            name: [bucket.bucketName],
          },
          object: {
            key: [{ prefix: "target/" }],
          },
        },
      },
      targets: [new events_targets.SfnStateMachine(execEcsRunStateMachine)],
    });
  }
}
