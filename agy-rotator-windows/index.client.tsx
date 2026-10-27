import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { AccountsSurface } from "./client/screen.tsx";

// agy-rotator-windows — a sidebar row ("agy accounts") opening the one screen: the saved Antigravity accounts, their quota, and
// Save / Switch / Remove. Current client API (addScreen / addSidebarHeaderItem), as remote-browser and agent-rescue use.
const SCREEN = "agy-rotator-windows";

function AccountsItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="Users" active={currentScreen?.screenId === SCREEN} onPress={() => openScreen({ screenId: SCREEN })} />;
}

export default function contribute(client: PluginClientContext) {
  const removers = [
    client.addScreen({ id: SCREEN, title: "agy rotator (Windows)", Component: AccountsSurface }),
    client.addSidebarHeaderItem({ id: "agy-rotator-windows", title: "agy rotator (Windows)", Component: AccountsItem }),
  ];
  return () => {
    for (const remove of removers) if (typeof remove === "function") void remove();
  };
}
