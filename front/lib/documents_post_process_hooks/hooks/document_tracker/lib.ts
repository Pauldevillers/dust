import { DustAPI } from "@dust-tt/types";

import { Authenticator, prodAPICredentialsForOwner } from "@app/lib/auth";
import { TRACKABLE_CONNECTOR_TYPES } from "@app/lib/documents_post_process_hooks/hooks/document_tracker/consts";
import logger from "@app/logger/logger";

export async function getTrackableDataSources(workspaceId: string): Promise<
  {
    workspace_id: string;
    data_source_id: string;
  }[]
> {
  const owner = (
    await Authenticator.internalBuilderForWorkspace(workspaceId)
  ).workspace();
  if (!owner) {
    throw new Error(
      `Could not get internal builder for workspace ${workspaceId}`
    );
  }
  const prodCredentials = await prodAPICredentialsForOwner(owner);

  const prodAPI = new DustAPI(prodCredentials, logger);

  // Fetch data sources
  const dsRes = await prodAPI.getDataSources(prodAPI.workspaceId());
  if (dsRes.isErr()) {
    throw dsRes.error;
  }
  const dataSources = dsRes.value;

  // Filter data sources to only include trackable ones
  const trackableDataSources = dataSources.filter(
    (ds) =>
      ds.connectorProvider &&
      TRACKABLE_CONNECTOR_TYPES.includes(ds.connectorProvider)
  );

  return trackableDataSources.map((ds) => ({
    workspace_id: prodAPI.workspaceId(),
    data_source_id: ds.name,
  }));
}
