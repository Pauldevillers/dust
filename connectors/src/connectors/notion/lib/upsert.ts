import axios, { AxiosRequestConfig, AxiosResponse } from "axios";

import logger from "@connectors/logger/logger";
import { DataSourceConfig } from "@connectors/types/data_source_config";

const DUST_API_URL = process.env.DUST_API_URL;
if (!DUST_API_URL) {
  throw new Error("DUST_API_URL not set");
}

export async function upsertToDatasource(
  dataSourceConfig: DataSourceConfig,
  documentId: string,
  documentText: string
) {
  const endpoint = `${DUST_API_URL}/api/v1/w/${dataSourceConfig.workspaceId}/data_sources//${dataSourceConfig.dataSourceName}/documents/${documentId}`;
  const dustRequestPayload = {
    text: documentText,
  };
  const dustRequestConfig: AxiosRequestConfig = {
    headers: {
      Authorization: `Bearer ${dataSourceConfig.workspaceAPIKey}`,
    },
  };

  let dustRequestResult: AxiosResponse;
  try {
    dustRequestResult = await axios.post(
      endpoint,
      dustRequestPayload,
      dustRequestConfig
    );
  } catch (e) {
    logger.error(e, "error uploading document to Dust");
    throw e;
  }

  if (dustRequestResult.status >= 200 && dustRequestResult.status < 300) {
    logger.info(
      { documentId, workspaceId: dataSourceConfig.workspaceId },
      "successfully uploaded document to Dust"
    );
  } else {
    logger.error(
      {
        documentId,
        workspaceId: dataSourceConfig.workspaceId,
        status: dustRequestResult.status,
      },
      "error uploading document to Dust"
    );
    throw new Error(`Error uploading to dust: ${dustRequestResult}`);
  }
}
