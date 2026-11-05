import {YdbClient} from '@aderevyankin/ydb-toolkit';

export const connectionString = 'grpc://localhost:2140/local';

export async function openLocal() {
  // Explicit credentials prevent inherited cloud auth/TLS from reaching a local test.
  const {AnonymousCredentialsProvider} = await import('@ydbjs/auth/anonymous');
  return YdbClient.connect({connectionString, driverOptions: {
    credentialsProvider: new AnonymousCredentialsProvider(),
  }});
}
