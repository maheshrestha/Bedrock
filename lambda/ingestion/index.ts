import type { SQSEvent, S3Event } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";

const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);

const tableName = process.env.INGESTION_STATE_TABLE_NAME!;
const knowledgeBaseId = process.env.KNOWLEDGE_BASE_ID!;
const dataSourceId = process.env.DATA_SOURCE_ID!;

const sfn = new SFNClient();
const stateMachineArn = process.env.INGESTION_STATE_MACHINE_ARN!;

export const handler = async (event: SQSEvent) => {
  console.log("Ingestion Lambda started");

  const pk = `${knowledgeBaseId}#${dataSourceId}`;

  let recordedUpload = false;
  for (const message of event.Records) {
    console.log("SQS message received:", message.messageId);

    const s3Event = JSON.parse(message.body) as S3Event;

    for (const record of s3Event.Records ?? []) {
      const bucket = record.s3.bucket.name;

      const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
      if (key === "content/" || key.endsWith("/")) {
        console.log("Skipping folder marker:", key);
        continue;
      }

      console.log("Document uploaded:", { bucket, key });

      // Increment generation atomically.
      await dynamodb.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { pk },
          UpdateExpression: `
            SET #state = if_not_exists(#state, :idle),
                #updatedAt = :now
            ADD #generation :one
          `,
          ExpressionAttributeNames: {
            "#state": "state",
            "#updatedAt": "updatedAt",
            "#generation": "generation",
          },
          ExpressionAttributeValues: {
            ":idle": "IDLE",
            ":now": new Date().toISOString(),
            ":one": 1,
          },
        }),
      );

      recordedUpload = true;
    }
  }

  if (recordedUpload) {
    await sfn.send(
      new StartExecutionCommand({
        stateMachineArn,
        name: `ingestion-${Date.now()}-${crypto.randomUUID()}`,
      }),
    );
  }

  console.log("All S3 upload events recorded in DynamoDB");

  return {
    message: "Upload events recorded successfully",
  };
};
