export { loadConfig, type Config } from "./config";
export { QUEUES, startQueue, type JobQueue, type JobPayloads, type QueueName, type StartedQueue } from "./queue";
export { ingestInbound, ingestOutbound } from "./ingest";
export { createOutlookGateway, ConnectionUnavailableError, type OutlookGateway } from "./outlook";
export { setupTestMail, setupTestState, testMailWouldBeInternal, type SetupTestState } from "./setup";
export {
  checkVatNumber,
  EU_COUNTRIES,
  normalizeVatNumber,
  OTHER_COUNTRY,
  taxTreatment,
  type TaxTreatment,
  type VatCheck,
  type VatStatus,
} from "./vat";
export { addDays, isValidTimeZone, isWeekend, localClock, startOfLocalDay, workingDaysBetween } from "./time";
