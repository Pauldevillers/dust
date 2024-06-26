import type {
  ConnectorsAPIError,
  ContentNode,
  ModelId,
  Result,
} from "@dust-tt/types";
import { Err, getNotionDatabaseTableId, Ok } from "@dust-tt/types";
import { v4 as uuidv4 } from "uuid";

import { notionConfig } from "@connectors/connectors/notion/lib/config";
import { validateAccessToken } from "@connectors/connectors/notion/lib/notion_api";
import {
  launchNotionSyncWorkflow,
  stopNotionSyncWorkflow,
} from "@connectors/connectors/notion/temporal/client";
import { dataSourceConfigFromConnector } from "@connectors/lib/api/data_source_config";
import {
  NotionConnectorState,
  NotionDatabase,
  NotionPage,
} from "@connectors/lib/models/notion";
import {
  nango_client,
  nangoDeleteConnection,
} from "@connectors/lib/nango_client";
import { getAccessTokenFromNango } from "@connectors/lib/nango_helpers";
import mainLogger from "@connectors/logger/logger";
import { ConnectorResource } from "@connectors/resources/connector_resource";
import type { DataSourceConfig } from "@connectors/types/data_source_config";
import type { NangoConnectionId } from "@connectors/types/nango_connection_id";

import type { ConnectorPermissionRetriever } from "../interface";
import { getParents } from "./lib/parents";

const { getRequiredNangoNotionConnectorId } = notionConfig;

const logger = mainLogger.child({ provider: "notion" });

export async function createNotionConnector(
  dataSourceConfig: DataSourceConfig,
  connectionId: NangoConnectionId
): Promise<Result<string, Error>> {
  const nangoConnectionId = connectionId;

  const notionAccessToken = await getAccessTokenFromNango({
    connectionId: nangoConnectionId,
    integrationId: getRequiredNangoNotionConnectorId(),
    useCache: false,
  });

  const isValidToken = await validateAccessToken(notionAccessToken);
  if (!isValidToken) {
    return new Err(new Error("Notion access token is invalid"));
  }

  let connector: ConnectorResource;
  try {
    const notionConfigurationBlob = {
      useDualWorkflow: true,
    };

    connector = await ConnectorResource.makeNew(
      "notion",
      {
        connectionId: nangoConnectionId,
        workspaceAPIKey: dataSourceConfig.workspaceAPIKey,
        workspaceId: dataSourceConfig.workspaceId,
        dataSourceName: dataSourceConfig.dataSourceName,
      },
      notionConfigurationBlob
    );
  } catch (e) {
    logger.error({ error: e }, "Error creating notion connector.");
    return new Err(e as Error);
  }

  try {
    await launchNotionSyncWorkflow(connector.id);
  } catch (e) {
    logger.error(
      {
        workspaceId: dataSourceConfig.workspaceId,
        dataSourceName: dataSourceConfig.dataSourceName,
        error: e,
      },
      "Error launching notion sync workflow."
    );
    await connector.delete();
    return new Err(e as Error);
  }

  return new Ok(connector.id.toString());
}

export async function updateNotionConnector(
  connectorId: ModelId,
  {
    connectionId,
  }: {
    connectionId?: NangoConnectionId | null;
  }
): Promise<Result<string, ConnectorsAPIError>> {
  const c = await ConnectorResource.fetchById(connectorId);
  if (!c) {
    logger.error({ connectorId }, "Connector not found");
    return new Err({
      message: "Connector not found",
      type: "connector_not_found",
    });
  }

  if (connectionId) {
    const oldConnectionId = c.connectionId;
    const connectionRes = await nango_client().getConnection(
      getRequiredNangoNotionConnectorId(),
      oldConnectionId,
      false
    );
    const newConnectionRes = await nango_client().getConnection(
      getRequiredNangoNotionConnectorId(),
      connectionId,
      false
    );

    const workspaceId = connectionRes?.credentials?.raw?.workspace_id || null;
    const newWorkspaceId =
      newConnectionRes?.credentials?.raw?.workspace_id || null;

    if (!workspaceId || !newWorkspaceId) {
      return new Err({
        type: "connector_update_error",
        message: "Error retrieving nango connection info to update connector",
      });
    }
    if (workspaceId !== newWorkspaceId) {
      return new Err({
        type: "connector_oauth_target_mismatch",
        message: "Cannot change workspace of a Notion connector",
      });
    }

    await c.update({ connectionId });
    nangoDeleteConnection(
      oldConnectionId,
      getRequiredNangoNotionConnectorId()
    ).catch((e) => {
      logger.error(
        { error: e, oldConnectionId },
        "Error deleting old Nango connection"
      );
    });

    const dataSourceConfig = dataSourceConfigFromConnector(c);
    try {
      await launchNotionSyncWorkflow(c.id);
    } catch (e) {
      logger.error(
        {
          workspaceId: dataSourceConfig.workspaceId,
          dataSourceName: dataSourceConfig.dataSourceName,
          error: e,
        },
        "Error launching notion sync workflow post update."
      );
      return new Err({
        type: "connector_update_error",
        message: "Error restarting sync workflow after updating connector",
      });
    }
  }

  return new Ok(c.id.toString());
}

export async function stopNotionConnector(
  connectorId: ModelId
): Promise<Result<undefined, Error>> {
  const connector = await ConnectorResource.fetchById(connectorId);

  if (!connector) {
    logger.error(
      {
        connectorId,
      },
      "Notion connector not found."
    );

    return new Err(new Error("Connector not found"));
  }

  try {
    await stopNotionSyncWorkflow(connector.id);
  } catch (e) {
    logger.error(
      {
        connectorId: connector.id,
        error: e,
      },
      "Error stopping notion sync workflow"
    );

    return new Err(e as Error);
  }

  return new Ok(undefined);
}

export async function pauseNotionConnector(
  connectorId: ModelId
): Promise<Result<undefined, Error>> {
  const connector = await ConnectorResource.fetchById(connectorId);

  if (!connector) {
    logger.error(
      {
        connectorId,
      },
      "Notion connector not found."
    );

    return new Err(new Error("Connector not found"));
  }

  await connector.markAsPaused();
  const stopRes = await stopNotionConnector(connector.id);
  if (stopRes.isErr()) {
    return stopRes;
  }

  return new Ok(undefined);
}

export async function unpauseNotionConnector(
  connectorId: ModelId
): Promise<Result<undefined, Error>> {
  const connector = await ConnectorResource.fetchById(connectorId);

  if (!connector) {
    logger.error(
      {
        connectorId,
      },
      "Notion connector not found."
    );

    return new Err(new Error("Connector not found"));
  }

  await connector.markAsUnpaused();
  const r = await resumeNotionConnector(connector.id);
  if (r.isErr()) {
    return r;
  }

  return new Ok(undefined);
}

export async function resumeNotionConnector(
  connectorId: ModelId
): Promise<Result<undefined, Error>> {
  const connector = await ConnectorResource.fetchById(connectorId);

  if (!connector) {
    logger.error(
      {
        connectorId: connectorId,
      },
      "Notion connector not found."
    );
    return new Err(new Error("Connector not found"));
  }

  const dataSourceConfig = dataSourceConfigFromConnector(connector);
  try {
    await launchNotionSyncWorkflow(
      connector.id,
      connector.lastSyncSuccessfulTime
        ? connector.lastSyncStartTime?.getTime()
        : null
    );
  } catch (e) {
    logger.error(
      {
        workspaceId: dataSourceConfig.workspaceId,
        dataSourceName: dataSourceConfig.dataSourceName,
        error: e,
      },
      "Error launching notion sync workflow."
    );
  }

  return new Ok(undefined);
}

export async function fullResyncNotionConnector(
  connectorId: ModelId,
  fromTs: number | null
) {
  const connector = await ConnectorResource.fetchById(connectorId);
  if (!connector) {
    logger.error({ connectorId }, "Notion connector not found.");
    return new Err(new Error("Connector not found"));
  }

  const notionConnectorState = await NotionConnectorState.findOne({
    where: {
      connectorId,
    },
  });

  if (!notionConnectorState) {
    logger.error({ connectorId }, "Notion connector state not found.");
    return new Err(new Error("Connector state not found"));
  }

  try {
    await stopNotionConnector(connector.id);
  } catch (e) {
    logger.error(
      {
        connectorId,
        workspaceId: connector.workspaceId,
        dataSourceName: connector.dataSourceName,
        e,
      },
      "Error stopping notion sync workflow."
    );

    return new Err(e as Error);
  }

  notionConnectorState.fullResyncStartTime = new Date();
  await notionConnectorState.save();

  try {
    await launchNotionSyncWorkflow(
      connector.id,
      fromTs,
      true //forceResync
    );
  } catch (e) {
    logger.error(
      {
        connectorId,
        workspaceId: connector.workspaceId,
        dataSourceName: connector.dataSourceName,
        error: e,
      },
      "Error launching notion sync workflow."
    );
  }

  return new Ok(connector.id.toString());
}

export async function cleanupNotionConnector(
  connectorId: ModelId
): Promise<Result<undefined, Error>> {
  const connector = await ConnectorResource.fetchById(connectorId);
  if (!connector) {
    logger.error({ connectorId }, "Notion connector not found.");
    return new Err(new Error("Connector not found"));
  }

  await deleteNangoConnection(connector.connectionId);

  const res = await connector.delete();
  if (res.isErr()) {
    logger.error(
      { connectorId, error: res.error },
      "Error cleaning up Notion connector."
    );
    return res;
  }

  return new Ok(undefined);
}

async function deleteNangoConnection(connectionId: NangoConnectionId) {
  const nangoRes = await nangoDeleteConnection(
    connectionId,
    getRequiredNangoNotionConnectorId()
  );
  if (nangoRes.isErr()) {
    logger.error(
      { err: nangoRes.error },
      "Error deleting connection from Nango"
    );
  }
}

export async function retrieveNotionConnectorPermissions({
  connectorId,
  parentInternalId,
  viewType,
}: Parameters<ConnectorPermissionRetriever>[0]): Promise<
  Result<ContentNode[], Error>
> {
  const c = await ConnectorResource.fetchById(connectorId);
  if (!c) {
    logger.error({ connectorId }, "Connector not found");
    return new Err(new Error("Connector not found"));
  }

  const parentId = parentInternalId || "workspace";

  const [pages, dbs] = await Promise.all([
    NotionPage.findAll({
      where: {
        connectorId,
        parentId,
      },
    }),
    NotionDatabase.findAll({
      where: {
        connectorId,
        parentId,
      },
    }),
  ]);

  const getPageNodes = async (page: NotionPage): Promise<ContentNode> => {
    const [childPage, childDB] = await Promise.all([
      NotionPage.findOne({
        where: {
          connectorId,
          parentId: page.notionPageId,
        },
      }),
      NotionDatabase.findOne({
        where: {
          connectorId,
          parentId: page.notionPageId,
        },
      }),
    ]);

    const expandable = childPage || childDB ? true : false;

    return {
      provider: c.type,
      internalId: page.notionPageId,
      parentInternalId:
        !page.parentId || page.parentId === "workspace" ? null : page.parentId,
      type: "file",
      title: page.title || "",
      sourceUrl: page.notionUrl || null,
      expandable,
      permission: "read",
      dustDocumentId: `notion-${page.notionPageId}`,
      lastUpdatedAt: page.lastUpsertedTs?.getTime() || null,
    };
  };

  let pageNodes = await Promise.all(pages.map((p) => getPageNodes(p)));
  // In structured data mode, we remove leaf node pages
  if (viewType === "tables") {
    pageNodes = pageNodes.filter((p) => p.expandable);
  }

  const getDbNodes = async (db: NotionDatabase): Promise<ContentNode> => {
    return {
      provider: c.type,
      internalId: db.notionDatabaseId,
      parentInternalId:
        !db.parentId || db.parentId === "workspace" ? null : db.parentId,
      type: "database",
      title: db.title || "",
      sourceUrl: db.notionUrl || null,
      expandable: true,
      permission: "read",
      dustDocumentId: `notion-database-${db.notionDatabaseId}`,
      lastUpdatedAt: db.structuredDataUpsertedTs?.getTime() ?? null,
    };
  };

  const dbNodes = await Promise.all(dbs.map((db) => getDbNodes(db)));

  const folderNodes: ContentNode[] = [];
  if (!parentInternalId) {
    const [orphanedPagesCount, orphanedDbsCount] = await Promise.all([
      NotionPage.count({
        where: {
          connectorId,
          parentId: "unknown",
        },
      }),
      NotionDatabase.count({
        where: {
          connectorId,
          parentId: "unknown",
        },
      }),
    ]);

    if (orphanedPagesCount + orphanedDbsCount > 0) {
      // We also need to return a "fake" top-level folder call "Orphaned" to include resources
      // we haven't been able to find a parent for.
      folderNodes.push({
        provider: c.type,
        // Orphaned resources in the database will have "unknown" as their parentId.
        internalId: "unknown",
        parentInternalId: null,
        type: "folder",
        title: "Orphaned Resources",
        sourceUrl: null,
        expandable: true,
        permission: "read",
        dustDocumentId: null,
        lastUpdatedAt: null,
      });
    }
  }

  const nodes = pageNodes.concat(dbNodes);

  nodes.sort((a, b) => {
    return a.title.localeCompare(b.title);
  });

  return new Ok(nodes.concat(folderNodes));
}

export async function retrieveNotionContentNodeParents(
  connectorId: ModelId,
  internalId: string,
  memoizationKey?: string
): Promise<Result<string[], Error>> {
  const connector = await ConnectorResource.fetchById(connectorId);
  if (!connector) {
    logger.error({ connectorId }, "Connector not found");
    return new Err(new Error("Connector not found"));
  }

  const memo = memoizationKey || uuidv4();

  try {
    const parents = await getParents(
      connectorId,
      internalId,
      new Set<string>(),
      memo
    );

    return new Ok(parents);
  } catch (e) {
    logger.error(
      { connectorId, internalId, memoizationKey, error: e },
      "Error retrieving notion resource parents"
    );
    return new Err(e as Error);
  }
}

export async function retrieveNotionContentNodes(
  connectorId: ModelId,
  internalIds: string[]
): Promise<Result<ContentNode[], Error>> {
  const [pages, dbs] = await Promise.all([
    NotionPage.findAll({
      where: {
        connectorId,
        notionPageId: internalIds,
      },
    }),
    NotionDatabase.findAll({
      where: {
        connectorId,
        notionDatabaseId: internalIds,
      },
    }),
  ]);

  const pageNodes: ContentNode[] = pages.map((page) => ({
    provider: "notion",
    internalId: page.notionPageId,
    parentInternalId:
      !page.parentId || page.parentId === "workspace" ? null : page.parentId,
    type: "file",
    title: page.title || "",
    sourceUrl: page.notionUrl || null,
    expandable: false,
    permission: "read",
    dustDocumentId: `notion-${page.notionPageId}`,
    lastUpdatedAt: page.lastUpsertedTs?.getTime() || null,
    dustTableId: null,
  }));

  const dbNodes: ContentNode[] = dbs.map((db) => ({
    provider: "notion",
    internalId: db.notionDatabaseId,
    parentInternalId:
      !db.parentId || db.parentId === "workspace" ? null : db.parentId,
    type: "database",
    title: db.title || "",
    sourceUrl: db.notionUrl || null,
    expandable: true,
    permission: "read",
    dustDocumentId: null,
    lastUpdatedAt: null,
    dustTableId: getNotionDatabaseTableId(db.notionDatabaseId),
  }));

  const contentNodes = pageNodes.concat(dbNodes);

  return new Ok(contentNodes);
}
