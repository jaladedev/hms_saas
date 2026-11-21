import { NewConnectionForm } from "@/components/staff/channel-create-form";
import { createConnection } from "@/lib/staff/channel-sync-actions";

/** Passes the server action to the client form that shows a new key once. */
export function ChannelCreateGate({ propertyId }: { propertyId: string }) {
  return <NewConnectionForm propertyId={propertyId} action={createConnection} />;
}
