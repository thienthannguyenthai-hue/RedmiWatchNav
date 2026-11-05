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
 * Parse a Google Maps URL or raw text to extract coordinates or place query.
 * Supports:
 * - Short links: https://maps.app.goo.gl/... or https://goo.gl/maps/...
 * - Standard links: https://www.google.com/maps/place/.../@10.7769,106.7009,17z
 * - Query links: https://maps.google.com/?q=10.7769,106.7009
 * - Direct coordinates: "10.7769, 106.7009"
 */
export async function parseGoogleMapsInput(
  input: string
): Promise<{ coordinate?: Coordinate; query?: string; label?: string }> {
  const trimmed = input.trim();

  // 1. Check direct coordinate pair "lat, lng"
  const directCoordMatch = trimmed.match(
    /^(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)$/
  );
  if (directCoordMatch) {
    const lat = parseFloat(directCoordMatch[1]);
    const lng = parseFloat(directCoordMatch[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return {
        coordinate: { latitude: lat, longitude: lng },
        label: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
      };
    }
  }

  let resolvedUrl = trimmed;

  // 2. If it's a shortened URL (maps.app.goo.gl or goo.gl), resolve redirect
  const urlMatch = trimmed.match(/https?:\/\/[^\s]+/i);
  if (urlMatch) {
    resolvedUrl = urlMatch[0];
    if (
      resolvedUrl.includes('goo.gl') ||
      resolvedUrl.includes('maps.app.goo.gl')
    ) {
      try {
        const res = await fetch(resolvedUrl, { method: 'GET' });
        if (res.url) {
          resolvedUrl = res.url;
        }
      } catch {
        // Fallback if fetch fails
      }
    }

    // Extract !3dLAT!4dLNG (exact pin coordinate in Google Maps URLs)
    const pinMatch = resolvedUrl.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    if (pinMatch) {
      const lat = parseFloat(pinMatch[1]);
      const lng = parseFloat(pinMatch[2]);
      const nameMatch = resolvedUrl.match(/\/place\/([^/@?]+)/);
      const label = nameMatch
        ? decodeURIComponent(nameMatch[1].replace(/\+/g, ' '))
        : `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      return { coordinate: { latitude: lat, longitude: lng }, label };
    }

    // Extract ?q=lat,lng or &ll=lat,lng or &destination=lat,lng
    const paramCoordMatch = resolvedUrl.match(
      /[?&](?:q|ll|destination|daddr|query)=(-?\d+\.\d+)(?:,|%2C)(-?\d+\.\d+)/i
    );
    if (paramCoordMatch) {
      const lat = parseFloat(paramCoordMatch[1]);
      const lng = parseFloat(paramCoordMatch[2]);
      return {
        coordinate: { latitude: lat, longitude: lng },
        label: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
      };
    }

    // Extract /@lat,lng
    const atCoordMatch = resolvedUrl.match(/\/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (atCoordMatch) {
      const lat = parseFloat(atCoordMatch[1]);
      const lng = parseFloat(atCoordMatch[2]);
      const nameMatch = resolvedUrl.match(/\/place\/([^/@?]+)/);
      const label = nameMatch
        ? decodeURIComponent(nameMatch[1].replace(/\+/g, ' '))
        : `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      return { coordinate: { latitude: lat, longitude: lng }, label };
    }

    // Extract place name from /place/Name or ?q=Name
    const placeNameMatch = resolvedUrl.match(/\/place\/([^/@?]+)/);
    if (placeNameMatch) {
      const placeQuery = decodeURIComponent(
        placeNameMatch[1].replace(/\+/g, ' ')
      );
      return { query: placeQuery, label: placeQuery };
    }

    const qParamMatch = resolvedUrl.match(/[?&](?:q|query|destination)=([^&]+)/i);
    if (qParamMatch) {
      const placeQuery = decodeURIComponent(qParamMatch[1].replace(/\+/g, ' '));
      return { query: placeQuery, label: placeQuery };
    }
  }

  return { query: trimmed, label: trimmed };
}

/**
 * Search places via OpenStreetMap Nominatim (Free, no API key required)
 */
export async function searchPlaces(query: string): Promise<PlaceSuggestion[]> {
  if (!query.trim()) return [];
  const encoded = encodeURIComponent(query.trim());
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encoded}&countrycodes=vn&limit=5&addressdetails=1`;
  const res = await fetch(url, {
    headers: {
      'Accept-Language': 'vi,en',
      'User-Agent': 'RedmiWatchNavApp/1.0',
    },
  });
  if (!res.ok) return [];
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
