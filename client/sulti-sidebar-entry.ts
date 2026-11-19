import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SultiChatBridge } from "./sulti-chat-bridge";
import { SultiSidebarHeader } from "./sulti-sidebar-header";

const CHAT_SCREEN = "sulti-chat";

export function contributeSultiSidebar(client: PluginClientContext) {
  const offScreen = client.addScreen({ id: CHAT_SCREEN, title: "Sulti", Component: SultiChatBridge });
  const offItem = client.addSidebarHeaderItem({ id: "sulti", title: "Sulti", Component: SultiSidebarHeader });
  return async () => {
    await Promise.all([offScreen(), offItem()]);
  };
}