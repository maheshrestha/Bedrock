import {
  BedrockAgentRuntimeClient,
  RetrieveAndGenerateCommand,
} from "@aws-sdk/client-bedrock-agent-runtime";

import type { APIGatewayProxyEventV2 } from "aws-lambda";

const bedrockClient = new BedrockAgentRuntimeClient({});

const knowledgeBaseId = process.env.KNOWLEDGE_BASE_ID!;
const generationModelArn = process.env.GENERATION_MODEL_ARN!;

interface AskRequest {
  question?: string;
  sessionId?: string;
}

const jsonResponse = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
});

export const handler = async (event: APIGatewayProxyEventV2) => {
  try {
    // 1. Read the incoming HTTP request
    if (!event.body) {
      return jsonResponse(400, {
        message: "Request body is required",
      });
    }

    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body;

    const body = JSON.parse(rawBody) as AskRequest;

    // 2. Validate the question
    const question = body.question?.trim();

    if (!question || question.length > 2000) {
      return jsonResponse(400, {
        message: "A question between 1 and 2000 characters is required",
      });
    }

    // 3. Query the Knowledge Base and generate an answer

    const command = new RetrieveAndGenerateCommand({
      // 1. QUESTION FROM THE USER

      input: {
        text: question,
      },

      // 2. CONFIGURE HOW BEDROCK SHOULD RETRIEVE INFORMATION
      // We are telling Bedrock to use a Knowledge Base (RAG).
      retrieveAndGenerateConfiguration: {
        type: "KNOWLEDGE_BASE",

        knowledgeBaseConfiguration: {
          // 3. WHICH KNOWLEDGE BASE SHOULD BEDROCK USE?
          // This is the ID of the Knowledge Base you created using CDK.
          knowledgeBaseId,

          // 4. WHICH AI MODEL SHOULD GENERATE THE ANSWER?
          // For example, Amazon Nova Lite.
          // This is the generation model, NOT the embedding model.
          modelArn: generationModelArn,

          // 5. RETRIEVAL CONFIGURATION
          // Bedrock searches the vector store for information
          // relevant to the user's question.
          retrievalConfiguration: {
            vectorSearchConfiguration: {
              // Return the 5 most relevant document chunks.
              // These chunks will provide context to the AI model.
              numberOfResults: 5,
            },
          },

          // 6. GENERATION CONFIGURATION
          // Configure how the AI model generates its answer
          // using the question and retrieved information.
          generationConfiguration: {
            inferenceConfig: {
              textInferenceConfig: {
                // Maximum number of tokens in the generated answer.
                maxTokens: 800,

                // Controls randomness.
                // Lower value = more focused and predictable answers.
                temperature: 0.2,

                // Another parameter controlling response diversity.
                // Used together with temperature.
                topP: 0.9,
              },
            },
          },
        },
      },

      // 7. CONVERSATION SESSION
      // If the user has an existing session, reuse its ID.
      // This allows Bedrock to maintain context across follow-up questions.
      // Example:
      // First question: "Tell me about the museum."
      // Follow-up: "When was it established?"
      ...(body.sessionId ? { sessionId: body.sessionId } : {}),
    });

    const result = await bedrockClient.send(command);

    // 4. Extract the answer and its source references
    const citations = (result.citations ?? []).map((citation, index) => ({
      citationNumber: index + 1,

      references: (citation.retrievedReferences ?? []).map((reference) => ({
        text: reference.content?.text,
        source: reference.location?.s3Location?.uri,
        metadata: reference.metadata,
      })),
    }));

    // 5. Return the answer to the frontend
    return jsonResponse(200, {
      question,
      answer: result.output?.text ?? "",
      sessionId: result.sessionId,
      citations,
    });
  } catch (error) {
    console.error("Ask question error:", error);

    return jsonResponse(500, {
      message: "Unable to answer your question at this time",
    });
  }
};
