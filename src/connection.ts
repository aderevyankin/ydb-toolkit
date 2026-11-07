import tls from "node:tls";
import {Driver} from "@ydbjs/core";
import {EnvironCredentialsProvider} from "@ydbjs/auth/environ";

export interface ConnectionOptions {
  connectionString: string;
  driverOptions?: ConstructorParameters<typeof Driver>[1];
}

export async function openDriver(options: ConnectionOptions): Promise<Driver> {
  const supplied = options.driverOptions ?? {};
  const credentialsProvider = supplied.credentialsProvider ?? new EnvironCredentialsProvider(options.connectionString);
  const secureOptions = supplied.secureOptions
    ?? (credentialsProvider instanceof EnvironCredentialsProvider ? credentialsProvider.secureOptions : null);
  const ca = secureOptions?.ca ?? null;
  const driver = new Driver(options.connectionString, {
    "ydb.sdk.ready_timeout_ms": 10000,
    "ydb.sdk.enable_discovery": false,
    ...supplied,
    credentialsProvider,
    ...(secureOptions ? {secureOptions: {
      ...secureOptions,
      ...(ca ? {ca: [...tls.rootCertificates, ...(Array.isArray(ca) ? ca : [ca])]} : {}),
    }} : {}),
  });
  try {
    await driver.ready();
    return driver;
  } catch (error: unknown) {
    driver.close();
    throw error;
  }
}

export function positiveMs(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) {
    throw new Error("Timeout must be a positive 32-bit integer in milliseconds");
  }
  return value;
}
