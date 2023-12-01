/**
 * Data Source configuration
 */

import { ModelId } from "../../../shared/model_id";

import { ioTsEnum } from "../../../shared/utils/iots_utils";
import { AgentActionConfigurationType } from "../../../front/assistant/agent";
import { AgentActionType } from "../../../front/assistant/conversation";

export const TIME_FRAME_UNITS = [
  "hour",
  "day",
  "week",
  "month",
  "year",
] as const;
export type TimeframeUnit = (typeof TIME_FRAME_UNITS)[number];
export const TimeframeUnitCodec = ioTsEnum<TimeframeUnit>(TIME_FRAME_UNITS);

export type TimeFrame = {
  duration: number;
  unit: TimeframeUnit;
};
export function isTimeFrame(arg: RetrievalTimeframe): arg is TimeFrame {
  return (
    (arg as TimeFrame).duration !== undefined &&
    (arg as TimeFrame).unit !== undefined
  );
}

export type DataSourceFilter = {
  tags: { in: string[]; not: string[] } | null;
  parents: { in: string[]; not: string[] } | null;
};

export type DataSourceConfiguration = {
  workspaceId: string;
  dataSourceId: string;
  filter: DataSourceFilter;
};

/**
 * Retrieval configuration
 */

export type TemplatedQuery = {
  template: string;
};
export function isTemplatedQuery(arg: RetrievalQuery): arg is TemplatedQuery {
  return (arg as TemplatedQuery).template !== undefined;
}

// Retrieval specifies a list of data sources (with possible parent / tags filtering, possible "all"
// data sources), a query ("auto" generated by the model "none", no query, `TemplatedQuery`, fixed
// query), a relative time frame ("auto" generated by the model, "none" no time filtering
// `TimeFrame`) which applies to all data sources, and a top_k parameter.
//
// `query` and `relativeTimeFrame` will be used to generate the inputs specification for the model
// in charge of generating the action inputs. The results will be used along with `topK` and
// `dataSources` to query the data.
export type RetrievalQuery = "auto" | "none" | TemplatedQuery;
export type RetrievalTimeframe = "auto" | "none" | TimeFrame;
export type RetrievalConfigurationType = {
  id: ModelId;
  sId: string;

  type: "retrieval_configuration";
  dataSources: DataSourceConfiguration[];
  query: RetrievalQuery;
  relativeTimeFrame: RetrievalTimeframe;
  topK: number | "auto";

  // Dynamically decide to skip, if needed in the future
  // autoSkip: boolean;
};

export function isRetrievalConfiguration(
  arg: AgentActionConfigurationType | null
): arg is RetrievalConfigurationType {
  return arg !== null && arg.type && arg.type === "retrieval_configuration";
}

/**
 * Retrieval action
 */

export type RetrievalDocumentType = {
  id: ModelId;
  dataSourceWorkspaceId: string;
  dataSourceId: string;
  sourceUrl: string | null;
  documentId: string;
  reference: string; // Short random string so that the model can refer to the document.
  timestamp: number;
  tags: string[];
  score: number | null;
  chunks: {
    text: string;
    offset: number;
    score: number | null;
  }[];
};

export function isRetrievalActionType(
  arg: AgentActionType
): arg is RetrievalActionType {
  return arg.type === "retrieval_action";
}

export type RetrievalActionType = {
  id: ModelId; // AgentRetrieval.
  type: "retrieval_action";
  params: {
    relativeTimeFrame: TimeFrame | null;
    query: string | null;
    topK: number;
  };
  documents: RetrievalDocumentType[] | null;
};