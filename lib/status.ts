import { setVoiceChannelName } from "./discord";

const APP_ID = "ebafpjfhleenmkcmdhlbdchpdalblhiellgfmmbb";
const DOWNLOADS_CHANNEL_ID = "1201441207688114246";
const VERSION_CHANNEL_ID = "1201446317709332540";

export async function refreshPalworldStatus() {
  const downloads = await getDownloads();
  const version = await getVersion();
  await setVoiceChannelName(DOWNLOADS_CHANNEL_ID, `Downloads: ${downloads}`);
  await setVoiceChannelName(VERSION_CHANNEL_ID, `Version: ${version}`);
}

export async function getDownloads() {
  const response = await fetch(
    `https://storeapi.overwolf.com/apps/download-counter?appids=[%22${APP_ID}%22]&r=${Date.now()}`
  );
  const json = (await response.json()) as Record<string, string>;
  return json[APP_ID];
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
