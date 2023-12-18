import { CoreAPI, CoreAPIDatabase } from "@dust-tt/types";
import { NextApiRequest, NextApiResponse } from "next";

import { getDataSource } from "@app/lib/api/data_sources";
import { Authenticator, getSession } from "@app/lib/auth";
import { isDevelopmentOrDustWorkspace } from "@app/lib/development";
import logger from "@app/logger/logger";
import { apiError, withLogging } from "@app/logger/withlogging";

type GetDatabaseResponseBody = {
  database: CoreAPIDatabase;
};

async function handler(
  req: NextApiRequest,
  res: NextApiResponse<GetDatabaseResponseBody | { success: true }>
): Promise<void> {
  const session = await getSession(req, res);
  const auth = await Authenticator.fromSession(
    session,
    req.query.wId as string
  );

  const owner = auth.workspace();
  const plan = auth.plan();
  if (!owner || !plan || !auth.isBuilder()) {
    return apiError(req, res, {
      status_code: 404,
      api_error: {
        type: "workspace_not_found",
        message: "The workspace you requested was not found.",
      },
    });
  }

  if (!isDevelopmentOrDustWorkspace(owner)) {
    res.status(404).end();
    return;
  }

  const dataSource = await getDataSource(auth, req.query.name as string);
  if (!dataSource) {
    return apiError(req, res, {
      status_code: 404,
      api_error: {
        type: "data_source_not_found",
        message: "The data source you requested was not found.",
      },
    });
  }

  const databaseId = req.query.dId;
  if (!databaseId || typeof databaseId !== "string") {
    return apiError(req, res, {
      status_code: 400,
      api_error: {
        type: "invalid_request_error",
        message: "The database id is missing.",
      },
    });
  }
  const coreAPI = new CoreAPI(logger);
  switch (req.method) {
    case "DELETE":
      const deleteRes = await coreAPI.deleteDatabase({
        projectId: dataSource.dustAPIProjectId,
        dataSourceName: dataSource.name,
        databaseId,
      });
      if (deleteRes.isErr()) {
        logger.error(
          {
            dataSourcename: dataSource.name,
            workspaceId: owner.id,
            error: deleteRes.error,
          },
          "Failed to delete database."
        );
        return apiError(req, res, {
          status_code: 500,
          api_error: {
            type: "internal_server_error",
            message: "Failed to delete database.",
          },
        });
      }

      return res.status(200).json({ success: true });

    default:
      return apiError(req, res, {
        status_code: 405,
        api_error: {
          type: "method_not_supported_error",
          message: "The method passed is not supported, DELETE is expected.",
        },
      });
  }
}

export default withLogging(handler);