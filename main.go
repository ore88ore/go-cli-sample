package main

import (
	"fmt"
	"os"
	"time"
)

func main() {
	fmt.Println("Start...")
	args := os.Args
	env := os.Getenv("ENV")

	if len(args) <= 1 || env == "" {
		fmt.Printf("引数または環境変数が設定されていない args: %s, env: %s", args, env)
		os.Exit(1)
	}

	fmt.Println("Wait...")
	time.Sleep(15 * time.Second)

	for i, arg := range args[1:] {
		fmt.Printf("Arg %d: %s\n", i+1, arg)
	}
	fmt.Println("ENV: " + env)
	fmt.Println("End...")
}
