import type { ReactNode } from "react";
import { Button } from "@/components/Button";
import { AppMain, Col, Panel } from "./Panel";
import { SourceActs, SourceLead, SourceTitle, SourceTop } from "./SourceHead";

/** A source URL that names nothing: says what was asked for and where to go instead. */
export function NotFoundSource({ kick, title, children }: { kick: string; title: string; children: ReactNode }) {
  return (
    <AppMain label={title}>
      <Col>
        <Panel id="nf-h">
          <SourceTop kick={kick} />
          <SourceTitle id="nf-h">{title}</SourceTitle>
          <SourceLead>{children}</SourceLead>
          <SourceActs>
            <Button size="md" variant="quiet" href="/app">
              Back to Discover
            </Button>
          </SourceActs>
        </Panel>
      </Col>
    </AppMain>
  );
}
