import { WebServiceClient } from '@maxmind/geoip2-node';
import { Request } from 'express';
import { settings } from './config.js';

type LocationData = {
  ip: string;
  city: string | null;
  state: string | null;
  country: string | null;
  postal_code: string | null;
};

const ipCache = new Map<string, LocationData>();

export const getClientIp = (request: Request): string => {
  const xff = request.headers['x-forwarded-for'];
  if (xff && typeof xff === 'string') {
    return xff.split(',')[0].trim();
  }

  return request.ip || request.connection.remoteAddress || 'unknown';
};

export const getLocation = async (
  ipAddress: string
): Promise<LocationData | null> => {
  console.log(`🔍 Getting client location for IP: ${ipAddress}`);

  if (
    ipAddress === 'unknown' ||
    ipAddress.includes('127.0.0.1') ||
    ipAddress.includes('localhost') ||
    ipAddress === '::1'
  ) {
    console.log('[LocationService] unknown ip address: ', ipAddress);
    return null;
  }

  const cached = ipCache.get(ipAddress);
  if (cached) {
    console.log(
      '[LocationService] cached response for ip address: ',
      ipAddress
    );
    return cached;
  }

  if (!settings.MAXMIND_ACCOUNT_ID || !settings.MAXMIND_LICENSE_KEY) {
    console.warn(
      '[LocationService] MaxMind account ID or license key not configured'
    );
    return null;
  }

  try {
    const client = new WebServiceClient(
      settings.MAXMIND_ACCOUNT_ID,
      settings.MAXMIND_LICENSE_KEY
    );
    const response = await client.city(ipAddress);

    let locationData: LocationData = {
      ip: ipAddress,
      city: null,
      state: null,
      country: null,
      postal_code: null,
    };

    if (response) {
      locationData = {
        ...locationData,
        city: response?.city?.names.en ?? null,
        state:
          response?.subdivisions?.[response.subdivisions.length - 1]?.names
            .en ?? null,
        country: response?.country?.isoCode ?? null,
        postal_code: response?.postal?.code ?? null,
      };

      console.log(
        `🔍 Client Location: city: ${locationData.city}, country: ${locationData.country}, state: ${locationData.state}, postal_code: ${locationData.postal_code}`
      );
    }

    ipCache.set(ipAddress, locationData);
    console.log('[LocationService] set cache for ip address: ', ipAddress);
    return locationData;
  } catch (error) {
    console.error(`Unexpected error geolocating IP ${ipAddress}:`, error);
    return null;
  }
};
