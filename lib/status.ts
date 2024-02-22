import { setVoiceChannelName } from "./discord";

export async function refreshPalworldStatus() {
  const downloads = await getDownloads(
    "ebafpjfhleenmkcmdhlbdchpdalblhiellgfmmbb"
  );
  const version = await getVersion();
  const currentAppVisitors = await getCurrentVisitors(
    "palworld.th.gl-app",
    process.env.PALWORLD_APP_PLAUSIBLE_AUTH_TOKEN!
  );
  const currentWebVisitors = await getCurrentVisitors(
    "palworld.th.gl",
    process.env.PALWORLD_WEB_PLAUSIBLE_AUTH_TOKEN!
  );
  await setVoiceChannelName("1201441207688114246", `Downloads: ${downloads}`);
  await setVoiceChannelName("1201446317709332540", `Version: ${version}`);
  await setVoiceChannelName(
    "1201479460306829322",
    `Online App: ${currentAppVisitors}`
  );
  await setVoiceChannelName(
    "1201479576287723601",
    `Online Web: ${currentWebVisitors}`
  );
}

export async function getDownloads(appId: string) {
  const response = await fetch(
    `https://storeapi.overwolf.com/apps/download-counter?appids=[%22${appId}%22]&r=${Date.now()}`
  );
  const json = (await response.json()) as Record<string, string>;
  return json[appId];
}

export async function getVersion() {
  const response = await fetch(
    `https://api.github.com/repos/lmachens/the-hidden-gaming-lair/contents/apps/palworld-overwolf/manifest.json`,
    {
      headers: {
        Accept: "application/vnd.github.raw+json",
        Authorization: `Bearer ${process.env.GITHUB_ACCESS_TOKEN}`,
      },
    }
  );
  const json = (await response.json()) as any;
  return json.meta.version;
}

export async function getCurrentVisitors(siteId: string, auth: string) {
  const response = await fetch(
    `https://metrics.th.gl/api/stats/${siteId}/current-visitors?auth=${auth}`
  );
  const currentVsitors = await response.text();
  return currentVsitors;
}
