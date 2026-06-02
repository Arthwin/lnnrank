"use strict";

const { buildCharacterKey, normalizeText, slugifyRealm } = require("./normalization");
const { extractZoneStats } = require("./zone-rankings");
const { formatIsoTimestamp, sleep } = require("./utils");

const TOKEN_URL = "https://www.warcraftlogs.com/oauth/token";
const CLIENT_GRAPHQL_URL = "https://www.warcraftlogs.com/api/v2/client";
const sharedTokenState = {
  clientKey: null,
  accessToken: null,
  tokenExpiresAt: 0,
  tokenPromise: null,
};

class WclRateLimitError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "WclRateLimitError";
    this.details = details;
  }
}

class WclClient {
  constructor(options = {}) {
    this.clientId = process.env.WCL_CLIENT_ID || options.clientId;
    this.clientSecret = process.env.WCL_CLIENT_SECRET || options.clientSecret;
    this.logger = options.logger;
    this.apiMode = options.apiMode || "v2";
    this.accessToken = null;
    this.tokenExpiresAt = 0;
  }

  assertConfigured() {
    if (!this.clientId || !this.clientSecret) {
      throw new Error("Missing WCL_CLIENT_ID or WCL_CLIENT_SECRET environment variables.");
    }
  }

  async getAccessToken() {
    this.assertConfigured();
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }

    const clientKey = `${this.clientId}:${this.clientSecret}`;
    if (
      sharedTokenState.clientKey === clientKey &&
      sharedTokenState.accessToken &&
      Date.now() < sharedTokenState.tokenExpiresAt - 60_000
    ) {
      this.accessToken = sharedTokenState.accessToken;
      this.tokenExpiresAt = sharedTokenState.tokenExpiresAt;
      return this.accessToken;
    }

    if (sharedTokenState.clientKey === clientKey && sharedTokenState.tokenPromise) {
      const payload = await sharedTokenState.tokenPromise;
      this.accessToken = payload.accessToken;
      this.tokenExpiresAt = payload.tokenExpiresAt;
      return this.accessToken;
    }

    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`, "utf8").toString("base64");
    sharedTokenState.clientKey = clientKey;
    sharedTokenState.tokenPromise = (async () => {
      const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to obtain WCL access token (${response.status}).`);
      }

      const payload = await response.json();
      return {
        accessToken: payload.access_token,
        tokenExpiresAt: Date.now() + ((payload.expires_in || 3600) * 1000),
      };
    })();

    try {
      const payload = await sharedTokenState.tokenPromise;
      sharedTokenState.accessToken = payload.accessToken;
      sharedTokenState.tokenExpiresAt = payload.tokenExpiresAt;
      this.accessToken = payload.accessToken;
      this.tokenExpiresAt = payload.tokenExpiresAt;
    } finally {
      sharedTokenState.tokenPromise = null;
    }

    return this.accessToken;
  }

  async graphQlRequest(query, variables) {
    const token = await this.getAccessToken();
    let attempt = 0;
    let lastRetryAfter = null;

    while (attempt < 4) {
      attempt += 1;
      const response = await fetch(CLIENT_GRAPHQL_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });

      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after")) || attempt;
        lastRetryAfter = retryAfter;
        if (retryAfter > 15 || attempt >= 2) {
          throw new WclRateLimitError("Warcraft Logs API rate limit reached.", {
            retryAfterSeconds: retryAfter,
          });
        }
        await sleep(retryAfter * 1000);
        continue;
      }

      if (response.status >= 500) {
        const retryAfter = Number(response.headers.get("retry-after")) || attempt;
        await sleep(retryAfter * 1000);
        continue;
      }

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`WCL GraphQL request failed (${response.status}): ${text.slice(0, 500)}`);
      }

      const payload = await response.json();
      if (payload.errors && payload.errors.length > 0) {
        const message = payload.errors.map((error) => error.message).join("; ");
        throw new Error(`WCL GraphQL returned errors: ${message}`);
      }

      return payload.data;
    }

    throw new WclRateLimitError("WCL GraphQL request exceeded retry budget due to rate limiting.", {
      retryAfterSeconds: lastRetryAfter,
    });
  }

  async getMetricEnumValues() {
    const query = `
      query MetricProbe {
        __type(name: "CharacterPageRankingMetricType") {
          enumValues {
            name
          }
        }
      }
    `;
    const data = await this.graphQlRequest(query, {});
    return (data.__type && data.__type.enumValues ? data.__type.enumValues : []).map((entry) => entry.name);
  }

  async getRegions() {
    const query = `
      query Regions {
        worldData {
          regions {
            id
            slug
            compactName
            name
          }
        }
      }
    `;
    const data = await this.graphQlRequest(query, {});
    return data.worldData.regions || [];
  }

  async getZoneCatalog() {
    const expansionsQuery = `
      query ZoneCatalogExpansions {
        worldData {
          expansions {
            id
            name
          }
        }
      }
    `;
    const expansionsData = await this.graphQlRequest(expansionsQuery, {});
    const expansions = expansionsData.worldData.expansions || [];
    const zones = [];

    const zonesQuery = `
      query ZoneCatalogZones($expansionId: Int!) {
        worldData {
          zones(expansion_id: $expansionId) {
            id
            name
            frozen
            partitions {
              id
              name
              compactName
              default
            }
            encounters {
              id
              name
            }
          }
        }
      }
    `;

    for (const expansion of expansions) {
      const zoneData = await this.graphQlRequest(zonesQuery, { expansionId: expansion.id });
      zones.push(...(zoneData.worldData.zones || []));
    }

    return {
      expansions,
      zones,
    };
  }

  resolveCurrentSeasonZone(zoneCatalog) {
    const zones = zoneCatalog.zones || [];
    const mythicZones = zones.filter((zone) => /mythic\+/i.test(zone.name || ""));
    if (mythicZones.length === 0) {
      throw new Error("Could not find a Mythic+ zone in the Warcraft Logs zone catalog.");
    }

    const active = mythicZones.filter((zone) => zone.frozen === false);
    const candidates = active.length > 0 ? active : mythicZones;
    candidates.sort((left, right) => right.id - left.id);

    const zone = candidates[0];
    const partitions = Array.isArray(zone.partitions) ? zone.partitions : [];
    const defaultPartition =
      partitions.find((entry) => entry.default) ||
      partitions.sort((left, right) => right.id - left.id)[0] ||
      null;

    return {
      zoneId: zone.id,
      zoneName: zone.name,
      partitionId: defaultPartition ? defaultPartition.id : null,
      partitionName: defaultPartition ? defaultPartition.name : null,
      encounterMap: new Map((zone.encounters || []).map((encounter) => [slugifyRealm(encounter.name), encounter.name])),
    };
  }

  async getRegionServers(regionId, page, limit) {
    const query = `
      query RegionServers($regionId: Int!, $page: Int!, $limit: Int!) {
        worldData {
          region(id: $regionId) {
            id
            slug
            compactName
            name
            servers(page: $page, limit: $limit) {
              data {
                id
                name
                normalizedName
                slug
                seasonID
              }
              total
              per_page
              current_page
              last_page
              has_more_pages
            }
          }
        }
      }
    `;

    const data = await this.graphQlRequest(query, { regionId, page, limit });
    return data.worldData.region;
  }

  async getServerCharacters({ regionSlug, serverSlug, page, limit, zoneId, partitionId, metricName }) {
    const query = `
      query ServerCharacters(
        $regionSlug: String!,
        $serverSlug: String!,
        $page: Int!,
        $limit: Int!,
        $zoneId: Int!,
        $partitionId: Int,
        $metricName: CharacterPageRankingMetricType!
      ) {
        worldData {
          server(region: $regionSlug, slug: $serverSlug) {
            id
            name
            normalizedName
            slug
            seasonID
            characters(page: $page, limit: $limit) {
              total
              per_page
              current_page
              last_page
              has_more_pages
              data {
                id
                canonicalID
                name
                hidden
                server {
                  slug
                  name
                  normalizedName
                  region {
                    slug
                    compactName
                    name
                  }
                }
                zoneRankings(
                  zoneID: $zoneId,
                  partition: $partitionId,
                  metric: $metricName,
                  timeframe: Historical,
                  includePrivateLogs: false
                )
              }
            }
          }
        }
      }
    `;

    const variables = {
      regionSlug,
      serverSlug,
      page,
      limit,
      zoneId,
      partitionId,
      metricName,
    };

    const data = await this.graphQlRequest(query, variables);
    return data.worldData.server;
  }
}

function buildRealmAliasMap(wclServers, rioRealms) {
  const rioAliasToRealm = new Map();
  for (const realmKey of rioRealms.keys()) {
    rioAliasToRealm.set(slugifyRealm(realmKey), realmKey);
  }

  const aliasMap = new Map();
  for (const server of wclServers) {
    const aliases = new Set([
      slugifyRealm(server.name),
      slugifyRealm(server.normalizedName),
      slugifyRealm(server.slug),
    ]);

    for (const alias of aliases) {
      if (!alias || !rioAliasToRealm.has(alias)) {
        continue;
      }
      aliasMap.set(alias, rioAliasToRealm.get(alias));
    }
  }

  return aliasMap;
}

function mapCharacterPage(result, collectedAt) {
  const server = result.server;
  const region = normalizeText(server.region.slug).toLowerCase();
  const realmKey = normalizeText(server.name);
  const zone = extractZoneStats(result.zoneRankings, collectedAt);
  const stableId = result.canonicalID || result.id || null;

  return {
    region,
    realmKey,
    characterName: normalizeText(result.name),
    normalizedKey: buildCharacterKey(region, realmKey, result.name),
    wclCharacterId: stableId,
    score: zone.score,
    dungeons: zone.dungeons,
    updatedAt: zone.updatedAt,
    rawDungeonCount: zone.rawDungeonCount,
  };
}

module.exports = {
  WclClient,
  WclRateLimitError,
  buildRealmAliasMap,
  mapCharacterPage,
};
