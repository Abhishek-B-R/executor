/**
 * Stored OAuth clients have no names: the service and its public client ID identify one. Two
 * clients of a service can share a client ID, such as an app's public client saved under several
 * settings before clients were stored, so where they do, how and when each was added tells them
 * apart, and the end of its stored ID when even that matches. None of it is secret.
 */
import type { OAuthClient } from "@executor-js/sdk";
import { LocalTime } from "../components/local-time.tsx";

type ClientIdentity = Pick<OAuthClient, "id" | "provider" | "clientId">;

/** Whether another of these clients has the same service and public client ID. */
export const sharesClientId = (client: ClientIdentity, clients: ReadonlyArray<ClientIdentity>) =>
  clients.some(
    (other) =>
      other.id !== client.id &&
      other.provider === client.provider &&
      other.clientId === client.clientId,
  );

const added: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };

/** How and when a client was added, and with a shared client ID, the end of its stored ID. */
export function OAuthClientOrigin({
  client,
  clients,
}: {
  readonly client: Pick<OAuthClient, "id" | "provider" | "clientId" | "source" | "createdAt">;
  readonly clients: ReadonlyArray<ClientIdentity>;
}) {
  return (
    <>
      {client.source === "manual" ? "Registered" : "Automatic"} · Added{" "}
      <LocalTime value={client.createdAt} options={added} />
      {sharesClientId(client, clients) ? ` · …${client.id.slice(-6)}` : null}
    </>
  );
}
