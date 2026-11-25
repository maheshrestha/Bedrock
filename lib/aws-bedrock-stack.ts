import * as cdk from "aws-cdk-lib/core";
import { Construct } from "constructs";
// import * as sqs from 'aws-cdk-lib/aws-sqs';
import {
  aws_s3 as s3,
  aws_s3vectors as s3vectors,
  aws_bedrock as bedrock,
  aws_iam as iam,
} from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";

export class AwsBedrockStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1) Source data
    const documentBucket = this.createDocumentBucket();

    // 2) Vector store for embeddings
    const {
      vectorBucket,
      vectorIndex,
      vectorIndexName,
      vectorBucketArn,
      vectorIndexArn,
    } = this.createVectorStore();

    // 3) Embedding model used by Bedrock
    const embeddingModelArn = this.getEmbeddingModelArn();

    // 4) Role that Bedrock uses to access the vector store and model
    const knowledgeBaseRole = this.createKnowledgeBaseRole();

    // 5) Bedrock knowledge base
    const knowledgeBase = this.createKnowledgeBase({
      roleArn: knowledgeBaseRole.roleArn,
      embeddingModelArn,
      vectorBucketArn: vectorBucket.attrVectorBucketArn,
      vectorIndexName,
    });

    knowledgeBase.node.addDependency(vectorIndex);
    knowledgeBase.node.addDependency(knowledgeBaseRole);

    // 6) Data source for S3 document ingestion
    const dataSource = this.createDataSource({
      knowledgeBase,
      bucketArn: documentBucket.bucketArn,
    });

    // 7. Create ingestion queue
    const ingestionQueue = this.createIngestionQueue();

    // 8. Create DynamoDB ingestion state table
    const ingestionStateTable = this.createIngestionStateTable();

    // 9. Create coordinator Lambda
    const coordinatorLambda = this.createCoordinatorLambda({
      knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
      dataSourceId: dataSource.attrDataSourceId,
      ingestionStateTable,
    });

    // 10. Create Step Functions state machine
    const ingestionStateMachine = this.createIngestionStateMachine({
      coordinatorLambda,
      knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
      dataSourceId: dataSource.attrDataSourceId,
    });

    // 11. Create dispatcher Lambda
    const ingestionLambda = this.createIngestionLambda({
      knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
      dataSourceId: dataSource.attrDataSourceId,
      documentBucket,
      ingestionQueue,
      ingestionStateTable,
      stateMachineArn: ingestionStateMachine.stateMachineArn,
    });

    // 8) Keep the resource creation order explicit
    dataSource.node.addDependency(knowledgeBase);

    // 9) Access permissions for Bedrock and the ingestion flow
    this.grantKnowledgeBaseAccess({
      knowledgeBaseRole,
      documentBucket,
      vectorBucketArn,
      vectorIndexArn,
      knowledgeBase,
      vectorBucket,
      embeddingModelArn,
    });

    // 10) Lambda that answers visitor questions
    const askQuestionLambda = this.createAskQuestionLambda({
      knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
    });

    // 11) HTTP API
    const httpApi = new apigwv2.HttpApi(this, "Api", {
      apiName: "api",
      description: "API for asking questions about documents and more",

      // Development setting to allow any origin to call the API. In production, restrict this to your website's domain.
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [apigwv2.CorsHttpMethod.POST],
        allowHeaders: ["content-type"],
      },
    });

    httpApi.addRoutes({
      path: "/ask",
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration(
        "AskQuestionIntegration",
        askQuestionLambda,
      ),
    });

    new cdk.CfnOutput(this, "QuestionApiUrl", {
      value: `${httpApi.apiEndpoint}/ask`,
    });

    // 12) Final outputs
    this.addOutputs({
      documentBucket,
      knowledgeBase,
      dataSource,
    });
  }

  private createDocumentBucket(): s3.Bucket {
    return new s3.Bucket(this, "MyDocumentBucket", {
      bucketName: process.env.DOCUMENT_BUCKET_NAME,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });
  }

  private createVectorStore(): {
    vectorBucket: s3vectors.CfnVectorBucket;
    vectorIndex: s3vectors.CfnIndex;
    vectorIndexName: string;
    vectorBucketArn: string;
    vectorIndexArn: string;
  } {
    const vectorBucket = new s3vectors.CfnVectorBucket(this, "MyVectorBucket", {
      vectorBucketName: `bedrock-rag-vectors-${this.account}-${this.region}`,
    });

    const vectorIndexName = "my-vector-index";
    const vectorIndex = new s3vectors.CfnIndex(this, "MyVectorIndex", {
      // vectorBucketName: vectorBucket.vectorBucketName,
      indexName: vectorIndexName,
      dataType: "float32",
      dimension: 1024,
      distanceMetric: "euclidean",
      metadataConfiguration: {
        nonFilterableMetadataKeys: [
          "AMAZON_BEDROCK_TEXT",
          "AMAZON_BEDROCK_METADATA",
        ],
      },
    });

    vectorIndex.node.addDependency(vectorBucket);

    return {
      vectorBucket,
      vectorIndex,
      vectorIndexName,
      vectorBucketArn: vectorBucket.attrVectorBucketArn,
      vectorIndexArn: vectorIndex.attrIndexArn,
    };
  }

  private getEmbeddingModelArn(): string {
    return `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`;
  }

  private createKnowledgeBaseRole(): iam.Role {
    return new iam.Role(this, "KnowledgeBaseRole", {
      assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com"),
      description: "Role for Bedrock Knowledge Base",
    });
  }

  private createKnowledgeBase(params: {
    roleArn: string;
    embeddingModelArn: string;
    vectorBucketArn: string;
    vectorIndexName: string;
  }): bedrock.CfnKnowledgeBase {
    const knowledgeBase = new bedrock.CfnKnowledgeBase(this, "KnowledgeBase", {
      name: "MyKnowledgeBase",
      description: "Knowledge base for Bedrock ingestion",
      roleArn: params.roleArn,
      knowledgeBaseConfiguration: {
        type: "VECTOR",
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: params.embeddingModelArn,
        },
      },
      storageConfiguration: {
        s3VectorsConfiguration: {
          vectorBucketArn: params.vectorBucketArn,
          indexName: params.vectorIndexName,
        },
        type: "S3_VECTORS",
      },
    });

    return knowledgeBase;
  }

  private createDataSource(params: {
    knowledgeBase: bedrock.CfnKnowledgeBase;
    bucketArn: string;
  }): bedrock.CfnDataSource {
    const dataSource = new bedrock.CfnDataSource(this, "CustomDataSource", {
      knowledgeBaseId: params.knowledgeBase.attrKnowledgeBaseId,
      name: "S3DataSource",
      dataSourceConfiguration: {
        type: "S3", // allowed values: S3 | CONFLUENCE | SALESFORCE | SHAREPOINT | WEB | CUSTOM | REDSHIFT_METADATA | MANAGED_KNOWLEDGE_BASE_CONNECTOR
        s3Configuration: {
          bucketArn: params.bucketArn,
          inclusionPrefixes: ["content/"],
        },
      },
    });

    dataSource.node.addDependency(params.knowledgeBase);
    return dataSource;
  }

  private createIngestionLambda(params: {
    knowledgeBaseId: string;
    dataSourceId: string;
    documentBucket: s3.Bucket;
    ingestionQueue: sqs.Queue;
    ingestionStateTable: dynamodb.Table;
    stateMachineArn: string;
  }): lambdaNodejs.NodejsFunction {
    const ingestionLambda = new lambdaNodejs.NodejsFunction(
      this,
      "MyIngestionLambda",
      {
        entry: "lambda/ingestion/index.ts",
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        timeout: cdk.Duration.minutes(1),
        // reservedConcurrentExecutions: 1, // avoid parallel execution
        environment: {
          KNOWLEDGE_BASE_ID: params.knowledgeBaseId,
          DATA_SOURCE_ID: params.dataSourceId,
          INGESTION_STATE_TABLE_NAME: params.ingestionStateTable.tableName,
          INGESTION_STATE_MACHINE_ARN: params.stateMachineArn,
        },
      },
    );

    // Grant ingestion Lambda permission to access the table
    params.ingestionStateTable.grantReadWriteData(ingestionLambda);

    // Allow this Lambda to start the coordinator workflow.
    ingestionLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["states:StartExecution"],
        resources: [params.stateMachineArn],
      }),
    );

    // Allow Lambda to consume SQS messages
    params.ingestionQueue.grantConsumeMessages(ingestionLambda);

    // Connect SQS to Lambda
    ingestionLambda.addEventSource(
      new lambdaEventSources.SqsEventSource(params.ingestionQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );

    // Connect S3 to SQS
    params.documentBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(params.ingestionQueue),
      { prefix: "content/" },
    );

    return ingestionLambda;
  }

  private grantKnowledgeBaseAccess(params: {
    knowledgeBaseRole: iam.Role;
    documentBucket: s3.Bucket;
    vectorBucketArn: string;
    vectorIndexArn: string;
    knowledgeBase: bedrock.CfnKnowledgeBase;
    vectorBucket: s3vectors.CfnVectorBucket;
    embeddingModelArn: string;
  }): void {
    // 1. Embedding model access
    params.knowledgeBaseRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["bedrock:InvokeModel"],
        resources: [params.embeddingModelArn],
      }),
    );

    // 2a. Source bucket: listing
    params.knowledgeBaseRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:ListBucket"],
        resources: [params.documentBucket.bucketArn],
        conditions: {
          StringLike: {
            "s3:prefix": ["content/", "content/*"],
          },
        },
      }),
    );

    // 2b. Source bucket: reading objects
    params.knowledgeBaseRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:GetObject"],
        resources: [params.documentBucket.arnForObjects("content/*")],
      }),
    );

    // 3. Vector store: identity-based policy on the role
    params.knowledgeBaseRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "s3vectors:GetIndex",
          "s3vectors:ListIndexes",
          "s3vectors:QueryVectors",
          "s3vectors:PutVectors",
          "s3vectors:GetVectors",
          "s3vectors:ListVectors",
          "s3vectors:DeleteVectors",
        ],
        resources: [params.vectorBucketArn, params.vectorIndexArn],
      }),
    );

    // 4. Vector store: resource-based policy on the vector bucket
    const vectorBucketPolicy = new s3vectors.CfnVectorBucketPolicy(
      this,
      "MyVectorBucketPolicy",
      {
        vectorBucketName: params.vectorBucket.vectorBucketName,
        vectorBucketArn: params.vectorBucket.attrVectorBucketArn,
        policy: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: {
                AWS: params.knowledgeBaseRole.roleArn,
              },
              Action: [
                "s3vectors:GetIndex",
                "s3vectors:ListIndexes",
                "s3vectors:QueryVectors",
                "s3vectors:PutVectors",
                "s3vectors:GetVectors",
                "s3vectors:ListVectors",
                "s3vectors:DeleteVectors",
              ],
              Resource: [params.vectorBucketArn, `${params.vectorBucketArn}/*`],
            },
          ],
        },
      },
    );

    // 5. add dependency so vectorBucketPolicy is created before KB
    params.knowledgeBase.node.addDependency(vectorBucketPolicy);
  }

  private addOutputs(params: {
    documentBucket: s3.Bucket;
    knowledgeBase: bedrock.CfnKnowledgeBase;
    dataSource: bedrock.CfnDataSource;
  }): void {
    new cdk.CfnOutput(this, "DocumentBucketName", {
      value: params.documentBucket.bucketName,
    });

    new cdk.CfnOutput(this, "KnowledgeBaseId", {
      value: params.knowledgeBase.attrKnowledgeBaseId,
    });

    new cdk.CfnOutput(this, "DataSourceId", {
      value: params.dataSource.attrDataSourceId,
    });
  }

  private createAskQuestionLambda(params: {
    knowledgeBaseId: string;
  }): lambdaNodejs.NodejsFunction {
    const generationModelArn = `arn:aws:bedrock:${this.region}::foundation-model/amazon.nova-lite-v1:0`;

    const askQuestionLambda = new lambdaNodejs.NodejsFunction(
      this,
      "AskQuestionLambda",
      {
        entry: "lambda/ask-question/index.ts",
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        timeout: cdk.Duration.seconds(28),
        environment: {
          KNOWLEDGE_BASE_ID: params.knowledgeBaseId,
          GENERATION_MODEL_ARN: generationModelArn,
        },
      },
    );

    // Permission to query the Knowledge Base and generate an answer.
    askQuestionLambda.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "bedrock:RetrieveAndGenerate",
          "bedrock:Retrieve",
          "bedrock:InvokeModel",
        ],
        resources: ["*"],
      }),
    );

    return askQuestionLambda;
  }

  private createIngestionQueue(): sqs.Queue {
    const deadLetterQueue = new sqs.Queue(this, "IngestionDeadLetterQueue", {
      queueName: "bedrock-ingestion-dlq",
      retentionPeriod: cdk.Duration.days(14),
    });

    const ingestionQueue = new sqs.Queue(this, "IngestionQueue", {
      queueName: "bedrock-ingestion-queue",
      visibilityTimeout: cdk.Duration.minutes(6),
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: {
        queue: deadLetterQueue,
        maxReceiveCount: 5,
      },
    });

    return ingestionQueue;
  }

  private createIngestionStateTable(): dynamodb.Table {
    return new dynamodb.Table(this, "IngestionStateTable", {
      tableName: "bedrock-ingestion-state",

      partitionKey: {
        name: "pk",
        type: dynamodb.AttributeType.STRING,
      },

      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,

      // development environment to minimise cost. For production update policy to RETAIN
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }

  private createCoordinatorLambda(params: {
    knowledgeBaseId: string;
    dataSourceId: string;
    ingestionStateTable: dynamodb.Table;
  }): lambdaNodejs.NodejsFunction {
    const coordinatorLambda = new lambdaNodejs.NodejsFunction(
      this,
      "IngestionCoordinatorLambda",
      {
        entry: "lambda/ingestion-coordinator/index.ts",
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_22_X,
        timeout: cdk.Duration.seconds(30),
        environment: {
          KNOWLEDGE_BASE_ID: params.knowledgeBaseId,
          DATA_SOURCE_ID: params.dataSourceId,
          INGESTION_STATE_TABLE_NAME: params.ingestionStateTable.tableName,
        },
      },
    );

    params.ingestionStateTable.grantReadWriteData(coordinatorLambda);

    return coordinatorLambda;
  }

  private createIngestionStateMachine(params: {
    coordinatorLambda: lambdaNodejs.NodejsFunction;
    knowledgeBaseId: string;
    dataSourceId: string;
  }): sfn.StateMachine {
    // 1. Acquire lock
    const acquireLock = new tasks.LambdaInvoke(this, "AcquireIngestionLock", {
      lambdaFunction: params.coordinatorLambda,
      payload: sfn.TaskInput.fromObject({
        action: "ACQUIRE",
        executionId: sfn.JsonPath.executionId,
      }),
      outputPath: "$.Payload",
    });

    // 2. Start Bedrock ingestion
    const startIngestion = new tasks.CallAwsService(
      this,
      "StartBedrockIngestion",
      {
        service: "bedrockagent",
        action: "startIngestionJob",
        parameters: {
          KnowledgeBaseId: params.knowledgeBaseId,
          DataSourceId: params.dataSourceId,
        },
        iamResources: ["*"], // @TODO: check this
        resultPath: "$.startResult",
      },
    );

    startIngestion.addRetry({
      errors: ["BedrockAgent.ConflictException"],
      interval: cdk.Duration.seconds(30),
      maxAttempts: 10,
      backoffRate: 1,
    });

    // 3. Wait before checking status
    const waitForIngestion = new sfn.Wait(this, "WaitForIngestion", {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(30)),
    });
    startIngestion.next(waitForIngestion);

    // 4. Get Bedrock ingestion status
    const getIngestionStatus = new tasks.CallAwsService(
      this,
      "GetBedrockIngestionStatus",
      {
        service: "bedrockagent",
        action: "getIngestionJob",
        parameters: {
          KnowledgeBaseId: params.knowledgeBaseId,
          DataSourceId: params.dataSourceId,
          IngestionJobId: sfn.JsonPath.stringAt(
            "$.startResult.IngestionJob.IngestionJobId",
          ),
        },
        iamResources: ["*"],
        resultPath: "$.getResult",
      },
    );

    // 5. Finalize successful ingestion
    const finalize = new tasks.LambdaInvoke(this, "FinalizeIngestion", {
      lambdaFunction: params.coordinatorLambda,
      payload: sfn.TaskInput.fromObject({
        action: "FINALIZE",
        executionId: sfn.JsonPath.executionId,
        processedGeneration: sfn.JsonPath.numberAt("$.generation"),
      }),
      resultPath: "$.finalizeResult",
    });

    // 6. Handle failed ingestion
    const releaseFailedLock = new tasks.LambdaInvoke(
      this,
      "ReleaseFailedIngestionLock",
      {
        lambdaFunction: params.coordinatorLambda,
        payload: sfn.TaskInput.fromObject({
          action: "FAIL",
          executionId: sfn.JsonPath.executionId,
          error: "Bedrock ingestion job failed or stopped",
        }),
        resultPath: "$.failureResult",
      },
    );

    startIngestion.addCatch(releaseFailedLock, {
      resultPath: "$.error",
    });

    getIngestionStatus.addCatch(releaseFailedLock, {
      resultPath: "$.error",
    });

    const ingestionFailed = new sfn.Fail(this, "IngestionFailed", {
      cause: "Bedrock knowledge base ingestion failed",
      error: "BedrockIngestionFailed",
    });

    releaseFailedLock.next(ingestionFailed);

    // 7. Check ingestion status
    const checkIngestionStatus = new sfn.Choice(this, "CheckIngestionStatus");

    checkIngestionStatus
      .when(
        sfn.Condition.stringEquals(
          "$.getResult.IngestionJob.Status",
          "COMPLETE",
        ),
        finalize,
      )
      .when(
        sfn.Condition.or(
          sfn.Condition.stringEquals(
            "$.getResult.IngestionJob.Status",
            "FAILED",
          ),
          sfn.Condition.stringEquals(
            "$.getResult.IngestionJob.Status",
            "STOPPED",
          ),
        ),
        releaseFailedLock,
      )
      .otherwise(waitForIngestion);

    waitForIngestion.next(getIngestionStatus);
    getIngestionStatus.next(checkIngestionStatus);

    // 8. Check whether another ingestion is required
    const checkMoreUploads = new sfn.Choice(this, "CheckForMoreUploads");

    checkMoreUploads
      .when(
        sfn.Condition.booleanEquals(
          "$.finalizeResult.Payload.needsAnotherIngestion",
          true,
        ),
        acquireLock,
      )
      .otherwise(new sfn.Succeed(this, "IngestionCompleted"));

    finalize.next(checkMoreUploads);

    // 9. Start only if lock was acquired
    const lockNotAcquired = new sfn.Succeed(this, "AnotherIngestionIsRunning");

    const checkLock = new sfn.Choice(this, "CheckLockAcquired");

    checkLock
      .when(sfn.Condition.booleanEquals("$.acquired", true), startIngestion)
      .otherwise(lockNotAcquired);

    acquireLock.next(checkLock);

    const stateMachine = new sfn.StateMachine(this, "IngestionStateMachine", {
      stateMachineName: "bedrock-ingestion-coordinator",
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(acquireLock),
      timeout: cdk.Duration.hours(2),
    });

    // Bedrock Agent API permissions
    stateMachine.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["bedrock:StartIngestionJob", "bedrock:GetIngestionJob"],
        resources: ["*"],
      }),
    );

    return stateMachine;
  }
}
