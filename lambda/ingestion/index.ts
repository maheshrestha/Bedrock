import {
  BedrockAgentClient,
  StartIngestionJobCommand,
} from "@aws-sdk/client-bedrock-agent";

import type { S3Event } from "aws-lambda";
import { randomUUID } from "node:crypto";

const bedrockClient = new BedrockAgentClient({});

const knowledgeBaseId = process.env.KNOWLEDGE_BASE_ID!;
const dataSourceId = process.env.DATA_SOURCE_ID!;

export const handler = async (event: S3Event) => {
  console.log("S3 upload event:", JSON.stringify(event));

  // Only process uploads under content/
  const hasContentUpload = event.Records.some((record) => {
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

    return key.startsWith("content/");
  });

  if (!hasContentUpload) {
    console.log("No content uploads found.");
    return;
  }

  // Ask Bedrock to synchronise the S3 data source.
  const response = await bedrockClient.send(
    new StartIngestionJobCommand({
      knowledgeBaseId,
      dataSourceId,
      clientToken: randomUUID(),
      description: "Synchronise newly uploaded documents",
    }),
  );

  console.log("Ingestion job started:", {
    ingestionJobId: response.ingestionJob?.ingestionJobId,
    status: response.ingestionJob?.status,
  });

  return {
    message: "Knowledge Base ingestion started",
    ingestionJobId: response.ingestionJob?.ingestionJobId,
  };
};
