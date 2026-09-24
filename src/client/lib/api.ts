/**
 * The API façade.
 *
 * Everything in the app imports `api` from here. The standalone demo build
 * aliases `./apiClient` to an in-memory implementation, so no page or
 * component needs to know which one it is talking to.
 */

export { ApiError } from './errors';
export { api } from './apiClient';
export type {
  DashboardResponse,
  ToolDetailResponse,
  ImportResult,
  ReminderRunResponse,
  AwsImportResponse,
} from './apiClient';
