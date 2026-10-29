"use client";

import { useEffect } from "react";
import { Button } from "@/components/Button";
import { AppMain, Col, Panel } from "@/components/app/Panel";
import { PlainShell } from "@/components/app/PlainShell";
import { SourceActs, SourceLead, SourceTitle, SourceTop } from "@/components/app/SourceHead";

/** A page that failed while rendering: says so, offers to render it again, and keeps the way back to Discover. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <PlainShell>
      <AppMain label="Error">
        <Col>
          <Panel id="err-h">
            <SourceTop kick={error.digest ? `Error · ${error.digest}` : "Error"} />
            <SourceTitle id="err-h">This page did not load</SourceTitle>
            <SourceLead>
              Something failed while reading it, most often the chain or the dreamDEX indexer not answering in time. Nothing was sent from your wallet. Try again in a
              moment.
            </SourceLead>
            <SourceActs>
              <Button size="md" onClick={reset}>
                Try again
              </Button>
              <Button size="md" variant="quiet" href="/app">
                Back to Discover
              </Button>
            </SourceActs>
          </Panel>
        </Col>
      </AppMain>
    </PlainShell>
  );
}
