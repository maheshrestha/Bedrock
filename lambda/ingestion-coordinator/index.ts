import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import {
  DynamoDBDocumentClient,
  UpdateCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";

interface CoordinatorEvent {
  action: "ACQUIRE" | "FINALIZE" | "FAIL";
  executionId: string;
  processedGeneration?: number;
  error?: string;
}

const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);

const tableName = process.env.INGESTION_STATE_TABLE_NAME!;
const knowledgeBaseId = process.env.KNOWLEDGE_BASE_ID!;
const dataSourceId = process.env.DATA_SOURCE_ID!;

const pk = `${knowledgeBaseId}#${dataSourceId}`;

export const handler = async (event: CoordinatorEvent) => {
  console.log("Coordinator event:", event);

  if (!event.executionId || !event.action) {
    throw new Error("Missing action or executionId");
  }

  switch (event.action) {
    case "ACQUIRE":
      return acquireLock(event.executionId);

    case "FINALIZE":
      if (event.processedGeneration === undefined) {
        throw new Error("Missing processedGeneration");
      }

      return finalizeIngestion(event.executionId, event.processedGeneration);

    case "FAIL":
      return failIngestion(event.executionId, event.error);

    default:
      throw new Error(`Unsupported action: ${event.action}`);
  }
};

async function acquireLock(executionId: string) {
  const now = new Date().toISOString();

  try {
    const result = await dynamodb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk },

        UpdateExpression: `
          SET #state = :running,
              #owner = :executionId,
              #startedAt = :now,
              #updatedAt = :now,
              #processedGeneration =
                if_not_exists(#processedGeneration, :zero)
        `,

        ConditionExpression: `
          attribute_exists(pk)
          AND (
            #state = :idle
            OR (#state = :running AND #owner = :executionId)
          )
        `,

        ExpressionAttributeNames: {
          "#state": "state",
          "#owner": "ownerExecutionId",
          "#startedAt": "startedAt",
          "#updatedAt": "updatedAt",
          "#processedGeneration": "processedGeneration",
        },

        ExpressionAttributeValues: {
          ":running": "RUNNING",
          ":idle": "IDLE",
          ":executionId": executionId,
          ":now": now,
          ":zero": 0,
        },

        ReturnValues: "ALL_NEW",
      }),
    );

    const generation = Number(result.Attributes?.generation ?? 0);

    console.log("Lock acquired", {
      executionId,
      generation,
    });

    return {
      acquired: true,
      executionId,
      pk,
      generation,
    };
  } catch (error: any) {
    if (error.name === "ConditionalCheckFailedException") {
      console.log("Lock already owned by another execution");

      return {
        acquired: false,
        reason: "LOCK_ALREADY_HELD",
        executionId,
      };
    }

    throw error;
  }
}

async function finalizeIngestion(
  executionId: string,
  processedGeneration: number,
) {
  const now = new Date().toISOString();

  // First check that this execution still owns the lock.
  const current = await dynamodb.send(
    new GetCommand({
      TableName: tableName,
      Key: { pk },
      ConsistentRead: true,
    }),
  );

  const item = current.Item;

  if (
    !item ||
    item.state !== "RUNNING" ||
    item.ownerExecutionId !== executionId
  ) {
    throw new Error("Ingestion lock ownership lost");
  }

  const currentGeneration = Number(item.generation ?? 0);

  // New uploads arrived while ingestion was running.
  if (currentGeneration > processedGeneration) {
    return {
      finalized: false,
      needsAnotherIngestion: true,
      currentGeneration,
      processedGeneration,
    };
  }

  // Release the lock only if generation has not changed since our read.
  try {
    await dynamodb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { pk },

        UpdateExpression: `
          SET #state = :idle,
              #processedGeneration = :processedGeneration,
              #updatedAt = :now
          REMOVE #owner, #startedAt
        `,

        ConditionExpression: `
          #state = :running
          AND #owner = :executionId
          AND #generation = :processedGeneration
        `,

        ExpressionAttributeNames: {
          "#state": "state",
          "#owner": "ownerExecutionId",
          "#startedAt": "startedAt",
          "#processedGeneration": "processedGeneration",
          "#generation": "generation",
          "#updatedAt": "updatedAt",
        },

        ExpressionAttributeValues: {
          ":idle": "IDLE",
          ":running": "RUNNING",
          ":executionId": executionId,
          ":processedGeneration": processedGeneration,
          ":now": now,
        },
      }),
    );

    return {
      finalized: true,
      needsAnotherIngestion: false,
      processedGeneration,
    };
  } catch (error: any) {
    if (error.name === "ConditionalCheckFailedException") {
      // An upload arrived between the Get and Update operations.
      return {
        finalized: false,
        needsAnotherIngestion: true,
        currentGeneration: Number(
          (
            await dynamodb.send(
              new GetCommand({
                TableName: tableName,
                Key: { pk },
                ConsistentRead: true,
              }),
            )
          ).Item?.generation ?? 0,
        ),
        processedGeneration,
      };
    }

    throw error;
  }
}

async function failIngestion(executionId: string, error?: string) {
  await dynamodb.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { pk },

      UpdateExpression: `
        SET #state = :idle,
            #lastError = :error,
            #updatedAt = :now
        REMOVE #owner, #startedAt
      `,

      ConditionExpression: `
        #state = :running AND #owner = :executionId
      `,

      ExpressionAttributeNames: {
        "#state": "state",
        "#owner": "ownerExecutionId",
        "#lastError": "lastError",
        "#updatedAt": "updatedAt",
        "#startedAt": "startedAt",
      },

      ExpressionAttributeValues: {
        ":idle": "IDLE",
        ":running": "RUNNING",
        ":executionId": executionId,
        ":error": error ?? "Unknown ingestion failure",
        ":now": new Date().toISOString(),
      },
    }),
  );

  return {
    failed: true,
    lockReleased: true,
  };
}
