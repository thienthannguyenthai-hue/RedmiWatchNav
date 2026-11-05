import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  Coordinate,
  NavStep,
  getDistanceMeters,
  formatDistance,
} from './navUtils';

export const BACKGROUND_NAV_TASK = 'BACKGROUND_REDMI_WATCH_NAV_TASK';
export const STORAGE_NAV_STATE_KEY = '@redmi_watch_nav_state_v1';

export interface PersistedNavState {
  isActive: boolean;
  destinationName: string;
  steps: NavStep[];
  currentStepIndex: number;
  lastUpdated: number;
}

// Configure Notifications so they show banners & trigger sound/vibration even when app is open
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/**
 * Send a high-priority local notification that iOS ANCS forwards immediately to Redmi Watch 5
 */
export async function sendWatchNotification(
  title: string,
  body: string
): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      sound: 'default',
      interruptionLevel: 'timeSensitive',
    },
    trigger: null, // Fire immediately
  });
}

/**
 * Evaluate current GPS location against active navigation steps.
 * Triggers notifications at 200m, 70m, and 20m thresholds and advances steps.
 */
export async function processLocationUpdate(
  currentCoord: Coordinate
): Promise<{
  state: PersistedNavState | null;
  distanceToNextTurn: number | null;
}> {
  const raw = await AsyncStorage.getItem(STORAGE_NAV_STATE_KEY);
  if (!raw) return { state: null, distanceToNextTurn: null };

  const state: PersistedNavState = JSON.parse(raw);
  if (!state.isActive || !state.steps || state.steps.length === 0) {
    return { state, distanceToNextTurn: null };
  }

  let idx = state.currentStepIndex;
  // Typically step 0 is "depart", so the upcoming turn is step 1 if we are on step 0
  if (idx === 0 && state.steps.length > 1) {
    idx = 1;
    state.currentStepIndex = 1;
  }

  const currentStep = state.steps[idx];
  if (!currentStep) {
    return { state, distanceToNextTurn: null };
  }

  const dist = getDistanceMeters(currentCoord, currentStep.maneuverLocation);
  let stateModified = false;

  // Check if it's the final arrival step
  if (currentStep.maneuverType === 'arrive') {
    if (dist <= 35 && !currentStep.alerted20) {
      currentStep.alerted20 = true;
      state.isActive = false;
      stateModified = true;
      await sendWatchNotification(
        `🏁 Đã đến nơi!`,
        `Bạn đã tới ${state.destinationName}`
      );
    }
  } else {
    // 1. Threshold: 200m (Prepare) - trigger when between 110m and 220m
    if (
      dist <= 220 &&
      dist > 95 &&
      !currentStep.alerted200 &&
      !currentStep.alerted70 &&
      !currentStep.alerted20
    ) {
      currentStep.alerted200 = true;
      stateModified = true;
      await sendWatchNotification(
        `${currentStep.arrowEmoji} Còn ${formatDistance(dist)}`,
        `Chuẩn bị: ${currentStep.instruction}`
      );
    }

    // 2. Threshold: 70m (Approaching turn) - trigger when between 35m and 90m
    if (dist <= 90 && dist > 32 && !currentStep.alerted70 && !currentStep.alerted20) {
      currentStep.alerted70 = true;
      currentStep.alerted200 = true;
      stateModified = true;
      await sendWatchNotification(
        `${currentStep.arrowEmoji} Sắp rẽ (${formatDistance(dist)})`,
        `${currentStep.instruction}`
      );
    }

    // 3. Threshold: 20m (Turn NOW) - trigger when <= 32m
    if (dist <= 32 && !currentStep.alerted20) {
      currentStep.alerted20 = true;
      currentStep.alerted70 = true;
      currentStep.alerted200 = true;
      stateModified = true;

      // Advance to next step after firing "Turn Now"
      const nextStep = state.steps[idx + 1];
      const nextHint = nextStep
        ? ` | Tiếp: ${nextStep.arrowEmoji} ${formatDistance(currentStep.distanceMeters)}`
        : '';

      await sendWatchNotification(
        `${currentStep.arrowEmoji} RẼ NGAY!`,
        `${currentStep.instruction}${nextHint}`
      );

      if (idx + 1 < state.steps.length) {
        state.currentStepIndex = idx + 1;
      }
    }
  }

  if (stateModified) {
    state.lastUpdated = Date.now();
    await AsyncStorage.setItem(STORAGE_NAV_STATE_KEY, JSON.stringify(state));
  }

  return { state, distanceToNextTurn: dist };
}

// Register Background Location Task for when iPhone screen is locked
TaskManager.defineTask(BACKGROUND_NAV_TASK, async ({ data, error }) => {
  if (error) {
    return;
  }
  if (data) {
    const { locations } = data as { locations: Location.LocationObject[] };
    if (locations && locations.length > 0) {
      const latest = locations[locations.length - 1];
      await processLocationUpdate({
        latitude: latest.coords.latitude,
        longitude: latest.coords.longitude,
      });
    }
  }
});
