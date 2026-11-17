#!/usr/bin/env node
import * as cdk from "aws-cdk-lib/core";
import { AwsBedrockStack } from "../lib/aws-bedrock-stack";

const app = new cdk.App();
new AwsBedrockStack(app, "AwsBedrockStack", {
  stackName: process.env.STAGE,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
