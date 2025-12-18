import { DataBackend } from "./DataBackend";
import { MockBackend } from "./MockBackend";
import { GoogleSheetsBackend } from "./GoogleSheetsBackend";
import { useSheets, env } from "../config";

let backend: DataBackend;

export function getBackend(): DataBackend {
  if (!backend) backend = useSheets ? new GoogleSheetsBackend() : new MockBackend();
  return backend;
}

export function getDefaultCity(): string {
  return (env.CITY_CODES.split(",")[0] || "FFM").trim();
}
