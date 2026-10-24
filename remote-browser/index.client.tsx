import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { BrowserSurface } from "./client/browser-surface";

// remote-browser — sidebar row "Remote Browser" opening a screen: a browser running on the daemon host
// (localhost = that host).
const SCREEN = "browser";

function Item({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="Globe" active={currentScreen?.screenId === SCREEN} onPress={() => openScreen({ screenId: SCREEN })} />;
}

export default function contribute(client: PluginClientContext) {
  const removers = [
    client.addScreen({ id: SCREEN, title: "Remote Browser", Component: BrowserSurface }),
    client.addSidebarHeaderItem({ id: "remote-browser", title: "Remote Browser", Component: Item }),
  ];
  return () => {
    for (const remove of removers) if (typeof remove === "function") void remove();
  };
}
