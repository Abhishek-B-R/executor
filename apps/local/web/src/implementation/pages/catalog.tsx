import { Failure } from "../components/common.tsx";
import { dashboardAtoms } from "../../contracts/dashboard-bindings.ts";
import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { CatalogEntry } from "@executor-js/catalog/contracts";
import type { App } from "@executor-js/sdk";
import { CatalogPage as Catalog, CatalogInstall } from "@executor-js/ui/dashboard/catalog";
import { Button } from "@executor-js/ui/components/button";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft02Icon } from "@hugeicons/core-free-icons";

/** Discovery and installation use the existing local app and account setup routes. */
export function CatalogPage() {
  const [selection, setSelection] = useState<CatalogEntry>();
  const navigate = useNavigate();
  const installed = (app: App) =>
    navigate({
      to: Object.keys(app.requirements.accounts).length ? "/apps/$appId/setup" : "/apps/$appId",
      params: { appId: app.id },
    });
  const back = () => setSelection(undefined);
  if (selection)
    return (
      <CatalogInstall
        mutation={dashboardAtoms.install}
        Failure={Failure}
        key={selection.id}
        entry={selection}
        onBack={back}
        onInstalled={installed}
      />
    );
  return (
    <Catalog
      query={dashboardAtoms.catalog}
      Failure={Failure}
      onSelect={setSelection}
      back={
        <Link
          to="/apps"
          className="back-link inline-flex gap-1.5 items-center text-[12px] text-muted-foreground mb-4.25 hover:text-foreground max-[740px]:min-h-11 max-[740px]:inline-flex max-[740px]:items-center max-[740px]:-mt-2 max-[740px]:mb-3"
        >
          <HugeiconsIcon icon={ArrowLeft02Icon} size={14} />
          Apps
        </Link>
      }
      action={
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/apps/add/custom">Connect a service</Link>
          </Button>
        </div>
      }
    />
  );
}
