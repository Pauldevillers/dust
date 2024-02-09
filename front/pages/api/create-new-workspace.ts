import type { WithAPIErrorReponse } from "@dust-tt/types";
import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth/next";

import { getUserFromSession } from "@app/lib/auth";
import { internalSubscribeWorkspaceToFreeTestPlan } from "@app/lib/plans/subscription";
import { apiError, withLogging } from "@app/logger/withlogging";
import { createAndLogMembership, createWorkspace } from "@app/pages/api/login";

import { authOptions } from "./auth/[...nextauth]";

async function handler(
  req: NextApiRequest,
  res: NextApiResponse<WithAPIErrorReponse<{ sId: string }>>
): Promise<void> {
  const session = await getServerSession(req, res, authOptions);
  if (!session) {
    res.status(401).end();
    return;
  }

  if (req.method !== "POST") {
    return apiError(req, res, {
      status_code: 405,
      api_error: {
        type: "method_not_supported_error",
        message: "The method passed is not supported, POST is expected.",
      },
    });
  }

  const user = await getUserFromSession(session);

  if (!user) {
    return apiError(req, res, {
      status_code: 401,
      api_error: {
        type: "invalid_request_error",
        message: "The user is not found.",
      },
    });
  }

  if (user.workspaces.length > 0) {
    return apiError(req, res, {
      status_code: 400,
      api_error: {
        type: "invalid_request_error",
        message: "The user already has a workspace.",
      },
    });
  }

  const workspace = await createWorkspace(session);
  await createAndLogMembership({
    workspace,
    userId: user.id,
    role: "admin",
  });
  await internalSubscribeWorkspaceToFreeTestPlan({
    workspaceId: workspace.sId,
  });

  res.status(200).json({ sId: workspace.sId });
}

export default withLogging(handler);