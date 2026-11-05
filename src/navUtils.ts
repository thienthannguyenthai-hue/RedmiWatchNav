export interface Coordinate {
  latitude: number;
  longitude: number;
}

export interface NavStep {
  index: number;
  instruction: string;
  streetName: string;
  maneuverType: string;
  maneuverModifier?: string;
  arrowEmoji: string;
  distanceMeters: number;
  durationSeconds: number;
  maneuverLocation: Coordinate;
  alerted200: boolean;
  alerted70: boolean;
  alerted20: boolean;
}

export interface PlaceSuggestion {
  displayName: string;
  shortName: string;
  coordinate: Coordinate;
}

/**
 * Calculate Haversine distance in meters between two coordinates
 */
export function getDistanceMeters(a: Coordinate, b: Coordinate): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h =
    sinDLat * sinDLat +
    Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return Math.round(R * c);
}

/**
 * Format distance nicely (e.g., 85m, 1.4km)
 */
export function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters)}m`;
  }
  return `${(meters / 1000).toFixed(1)}km`;
}

/**
 * Convert OSRM maneuver type + modifier into Vietnamese text & arrow emoji for Redmi Watch 5
 */
export function formatStepVietnamese(
  type: string,
  modifier: string | undefined,
  streetName: string,
  exit?: number
): { instruction: string; arrowEmoji: string } {
  const target = streetName ? ` vào ${streetName}` : '';

  if (type === 'arrive') {
    return {
      instruction: `Đến điểm đích${streetName ? ` (${streetName})` : ''}`,
      arrowEmoji: '🏁',
    };
  }

  if (type === 'depart') {
    return {
      instruction: `Xuất phát${ streetName ? ` trên ${streetName}` : '' }`,
      arrowEmoji: '⬆️',
    };
  }

  if (type === 'roundabout' || type === 'rotary') {
    const exitText = exit ? ` lối ra thứ ${exit}` : '';
    return {
      instruction: `Vào vòng xuyến, đi theo${exitText}${target}`,
      arrowEmoji: '🔄',
    };
  }

  if (modifier === 'uturn') {
    return {
      instruction: `Quay đầu xe${target}`,
      arrowEmoji: '↩️',
    };
  }

  if (modifier === 'sharp right') {
    return {
      instruction: `Rẽ phải gấp${target}`,
      arrowEmoji: '⤵️',
    };
  }

  if (modifier === 'right') {
    return {
      instruction: `Rẽ phải${target}`,
      arrowEmoji: '➡️',
    };
  }

  if (modifier === 'slight right') {
    return {
      instruction: `Chếch sang phải${target}`,
      arrowEmoji: '↗️',
    };
  }

  if (modifier === 'sharp left') {
    return {
      instruction: `Rẽ trái gấp${target}`,
      arrowEmoji: '⤶',
    };
  }

  if (modifier === 'left') {
    return {
      instruction: `Rẽ trái${target}`,
      arrowEmoji: '⬅️',
    };
  }

  if (modifier === 'slight left') {
    return {
      instruction: `Chếch sang trái${target}`,
      arrowEmoji: '↖️',
    };
  }

  return {
    instruction: `Đi thẳng${ streetName ? ` theo ${streetName}` : '' }`,
    arrowEmoji: '⬆️',
  };
}

/**
 * Parse DMS coordinates (e.g., 16°28'02.6"N 107°35'25.8"E)
 */
function parseDMS(input: string): Coordinate | null {
  const dmsRegex =
    /(\d+)[°\s]+(\d+)['\s]+([\d.]+)"?\s*([NS])[\s,]+(\d+)[°\s]+(\d+)['\s]+([\d.]+)"?\s*([EW])/i;
  const match = input.match(dmsRegex);
  if (!match) return null;

  let lat =
    parseFloat(match[1]) +
    parseFloat(match[2]) / 60 +
    parseFloat(match[3]) / 3600;
  if (match[4].toUpperCase() === 'S') lat = -lat;

  let lng =
    parseFloat(match[5]) +
    parseFloat(match[6]) / 60 +
    parseFloat(match[7]) / 3600;
  if (match[8].toUpperCase() === 'W') lng = -lng;

  return { latitude: lat, longitude: lng };
}

/**
 * Extract coordinates from any URL or HTML string
 */
function extractCoordinatesFromString(text: string): Coordinate | null {
  // 1. !3dLAT!4dLNG
  const pinMatch = text.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (pinMatch) {
    return { latitude: parseFloat(pinMatch[1]), longitude: parseFloat(pinMatch[2]) };
  }

  // 2. /@lat,lng
  const atMatch = text.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (atMatch) {
    return { latitude: parseFloat(atMatch[1]), longitude: parseFloat(atMatch[2]) };
  }

  // 3. ?q=lat,lng or destination=lat,lng or center=lat,lng
  const queryMatch = text.match(
    /[?&](?:q|destination|daddr|ll|center|query)=(-?\d+\.\d+)(?:,|%2C)(-?\d+\.\d+)/i
  );
  if (queryMatch) {
    return { latitude: parseFloat(queryMatch[1]), longitude: parseFloat(queryMatch[2]) };
  }

  // 4. [null,null,lat,lng] inside Google internal JS
  const internalJsMatch = text.match(/\[null,null,(-?\d+\.\d+),(-?\d+\.\d+)\]/);
  if (internalJsMatch) {
    return { latitude: parseFloat(internalJsMatch[1]), longitude: parseFloat(internalJsMatch[2]) };
  }

  return null;
}

/**
 * Parse Google Maps input: URLs, DMS, raw coordinates, or search queries
 */
export async function parseGoogleMapsInput(
  input: string
): Promise<{ coordinate?: Coordinate; query?: string; label?: string }> {
  const trimmed = input.trim();

  // 1. Check DMS coordinates (e.g., 16°28'02.6"N 107°35'25.8"E)
  const dms = parseDMS(trimmed);
  if (dms) {
    return {
      coordinate: dms,
      label: `${dms.latitude.toFixed(5)}, ${dms.longitude.toFixed(5)}`,
    };
  }

  // 2. Check standard decimal coordinates "16.46740, 107.59050" anywhere in text
  const decimalMatch = trimmed.match(
    /(-?\d{1,2}\.\d{3,})\s*[,;\s]\s*(-?\d{1,3}\.\d{3,})/
  );
  if (decimalMatch) {
    const lat = parseFloat(decimalMatch[1]);
    const lng = parseFloat(decimalMatch[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return {
        coordinate: { latitude: lat, longitude: lng },
        label: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
      };
    }
  }

  // 3. Check if input contains a URL
  const urlMatch = trimmed.match(/https?:\/\/[^\s]+/i);
  if (urlMatch) {
    let targetUrl = urlMatch[0];

    // Try extracting coordinates directly from URL if already expanded
    let directCoord = extractCoordinatesFromString(targetUrl);
    if (directCoord) {
      const nameMatch = targetUrl.match(/\/place\/([^/@?]+)/);
      const label = nameMatch
        ? decodeURIComponent(nameMatch[1].replace(/\+/g, ' '))
        : `${directCoord.latitude.toFixed(5)}, ${directCoord.longitude.toFixed(5)}`;
      return { coordinate: directCoord, label };
    }

    // If it's a short link (maps.app.goo.gl or goo.gl/maps), resolve it
    if (targetUrl.includes('goo.gl') || targetUrl.includes('maps.app.goo.gl')) {
      try {
        const res = await fetch(targetUrl, {
          method: 'GET',
          headers: {
            'User-Agent':
              'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)',
          },
        });

        if (res.url && res.url !== targetUrl) {
          const fromResUrl = extractCoordinatesFromString(res.url);
          if (fromResUrl) {
            const nameMatch = res.url.match(/\/place\/([^/@?]+)/);
            const label = nameMatch
              ? decodeURIComponent(nameMatch[1].replace(/\+/g, ' '))
              : `${fromResUrl.latitude.toFixed(5)}, ${fromResUrl.longitude.toFixed(5)}`;
            return { coordinate: fromResUrl, label };
          }
        }

        // Parse HTML body for redirect meta or embedded coordinates
        const html = await res.text();
        const fromHtml = extractCoordinatesFromString(html);
        if (fromHtml) {
          return {
            coordinate: fromHtml,
            label: `${fromHtml.latitude.toFixed(5)}, ${fromHtml.longitude.toFixed(5)}`,
          };
        }

        // Try to find meta refresh URL
        const metaMatch = html.match(/content="[^"]*url=([^"]+)"/i);
        if (metaMatch) {
          const redirectUrl = metaMatch[1];
          const fromRedirect = extractCoordinatesFromString(redirectUrl);
          if (fromRedirect) {
            return {
              coordinate: fromRedirect,
              label: `${fromRedirect.latitude.toFixed(5)}, ${fromRedirect.longitude.toFixed(5)}`,
            };
          }
        }
      } catch {
        // Fallback to text query if fetch fails
      }
    }

    // Try extracting place name from URL
    const placeNameMatch = targetUrl.match(/\/place\/([^/@?]+)/);
    if (placeNameMatch) {
      const placeQuery = decodeURIComponent(placeNameMatch[1].replace(/\+/g, ' '));
      return { query: placeQuery, label: placeQuery };
    }
  }

  // If no URL or coordinates found, treat as text search query (strip URLs if any)
  const cleanQuery = trimmed.replace(/https?:\/\/[^\s]+/gi, '').trim();
  return { query: cleanQuery || trimmed, label: cleanQuery || trimmed };
}

/**
 * Search places using Photon (Komoot) + OpenStreetMap Nominatim fallback
 * Photon provides fuzzy matching, typo tolerance, and superior POI/street search for Vietnam.
 */
export async function searchPlaces(query: string): Promise<PlaceSuggestion[]> {
  const q = query.trim();
  if (!q) return [];

  // 1. Try Photon (fast, typo-tolerant, excellent for Vietnamese landmarks & streets)
  try {
    const encoded = encodeURIComponent(q);
    const photonUrl = `https://photon.komoot.io/api/?q=${encoded}&limit=6&lang=vi`;
    const res = await fetch(photonUrl);
    if (res.ok) {
      const data = await res.json();
      if (data.features && data.features.length > 0) {
        return data.features.map((f: any) => {
          const props = f.properties || {};
          const name = props.name || props.street || q;
          const details = [
            props.housenumber,
            props.street,
            props.district,
            props.city || props.state,
            props.country,
          ]
            .filter(Boolean)
            .join(', ');

          return {
            shortName: name,
            displayName: details ? `${name} (${details})` : name,
            coordinate: {
              latitude: f.geometry.coordinates[1],
              longitude: f.geometry.coordinates[0],
            },
          };
        });
      }
    }
  } catch {
    // Fallback to Nominatim
  }

  // 2. Fallback to Nominatim OSM
  try {
    const encoded = encodeURIComponent(q);
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encoded}&countrycodes=vn&limit=5&addressdetails=1`;
    const res = await fetch(url, {
      headers: {
        'Accept-Language': 'vi,en',
        'User-Agent': 'RedmiWatchNavApp/1.0',
      },
    });
    if (res.ok) {
      const data = await res.json();
      return data.map((item: any) => ({
        displayName: item.display_name,
        shortName: item.name || item.display_name.split(',')[0],
        coordinate: {
          latitude: parseFloat(item.lat),
          longitude: parseFloat(item.lon),
        },
      }));
    }
  } catch {
    // ignore
  }

  return [];
}

/**
 * Fetch turn-by-turn route from OSRM
 */
export async function fetchRoute(
  start: Coordinate,
  end: Coordinate
): Promise<{
  steps: NavStep[];
  polyline: Coordinate[];
  totalDistanceMeters: number;
  totalDurationSeconds: number;
}> {
  const url = `https://router.project-osrm.org/route/v1/driving/${start.longitude},${start.latitude};${end.longitude},${end.latitude}?overview=full&geometries=geojson&steps=true`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error('Không thể tải lộ trình chỉ đường.');
  }
  const data = await res.json();
  if (!data.routes || data.routes.length === 0) {
    throw new Error('Không tìm thấy đường đi giữa 2 vị trí này.');
  }

  const route = data.routes[0];
  const coordinates: Coordinate[] = route.geometry.coordinates.map(
    (c: [number, number]) => ({
      latitude: c[1],
      longitude: c[0],
    })
  );

  const rawSteps = route.legs[0]?.steps || [];
  const steps: NavStep[] = rawSteps.map((s: any, idx: number) => {
    const type = s.maneuver?.type || 'continue';
    const modifier = s.maneuver?.modifier;
    const streetName = s.name || s.ref || '';
    const exit = s.maneuver?.exit;
    const { instruction, arrowEmoji } = formatStepVietnamese(
      type,
      modifier,
      streetName,
      exit
    );

    return {
      index: idx,
      instruction,
      streetName,
      maneuverType: type,
      maneuverModifier: modifier,
      arrowEmoji,
      distanceMeters: Math.round(s.distance || 0),
      durationSeconds: Math.round(s.duration || 0),
      maneuverLocation: {
        latitude: s.maneuver.location[1],
        longitude: s.maneuver.location[0],
      },
      alerted200: false,
      alerted70: false,
      alerted20: false,
    };
  });

  return {
    steps,
    polyline: coordinates,
    totalDistanceMeters: Math.round(route.distance || 0),
    totalDurationSeconds: Math.round(route.duration || 0),
  };
}
