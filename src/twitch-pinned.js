const TWITCH_PUBLIC_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const GET_PINNED_CHAT_HASH = '450320a012e0f1704586e55755307ca3f8a4c611d678687cc3e202471a33e615';

const channelIdCache = new Map();

/**
 * Resolves Twitch Channel ID from username login using public GQL
 */
export async function getTwitchChannelId(channelLogin) {
  const clean = (channelLogin || '').replace(/^[#/]+/, '').toLowerCase();
  if (!clean) return null;
  if (channelIdCache.has(clean)) return channelIdCache.get(clean);

  try {
    const res = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: {
        'Client-Id': TWITCH_PUBLIC_CLIENT_ID,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: `query { user(login: "${clean}") { id displayName } }`
      })
    });
    const data = await res.json();
    const id = data?.data?.user?.id || null;
    if (id) {
      channelIdCache.set(clean, id);
    }
    return id;
  } catch (err) {
    console.error(`Failed to resolve channelId for ${clean}:`, err);
    return null;
  }
}

/**
 * Fetches the currently pinned chat message for a channel using Twitch's public GQL persisted query
 */
export async function fetchPinnedChatMessage(channelLogin) {
  const clean = (channelLogin || '').replace(/^[#/]+/, '').toLowerCase();
  if (!clean) return null;

  const channelId = await getTwitchChannelId(clean);
  if (!channelId) return null;

  try {
    const payload = [
      {
        operationName: 'GetPinnedChat',
        variables: {
          channelID: channelId,
          count: 5
        },
        extensions: {
          persistedQuery: {
            version: 1,
            sha256Hash: GET_PINNED_CHAT_HASH
          }
        }
      }
    ];

    const res = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: {
        'Client-Id': TWITCH_PUBLIC_CLIENT_ID,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const json = await res.json();
    const edges = json?.[0]?.data?.channel?.pinnedChatMessages?.edges || [];
    if (edges.length === 0) return null;

    const firstNode = edges[0]?.node;
    if (!firstNode) return null;

    const pinnedMessage = firstNode.pinnedMessage;
    const pinnedBy = firstNode.pinnedBy?.displayName || firstNode.pinnedBy?.login || 'Moderador';
    const text = pinnedMessage?.content?.text || '';
    const author = pinnedMessage?.sender?.displayName || pinnedMessage?.sender?.login || 'Moderador';
    const id = firstNode.id;

    if (!text) return null;

    return {
      id,
      channel: clean,
      text,
      pinnedBy,
      author,
      updatedAt: firstNode.updatedAt || new Date().toISOString()
    };
  } catch (err) {
    console.error(`Failed to fetch pinned chat message for ${clean}:`, err);
    return null;
  }
}
