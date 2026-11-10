import { Platform, PermissionsAndroid } from 'react-native';

export interface PermissionStatus {
  hasNotificationPermission: boolean;
  hasStoragePermission: boolean;
  isPermissionGranted: boolean;
}

/**
 * Checks current permission status without prompting.
 */
export async function checkMaglevPermissions(): Promise<PermissionStatus> {
  if (Platform.OS !== 'android') {
    return {
      hasNotificationPermission: true,
      hasStoragePermission: true,
      isPermissionGranted: true,
    };
  }

  let hasNotification = true;
  let hasStorage = true;

  try {
    // Android 13+ (API 33+) requires POST_NOTIFICATIONS runtime permission
    if (Platform.Version >= 33) {
      hasNotification = await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
      );
    }

    // Android 12 (API 32) and below checks storage permissions
    if (Platform.Version < 33) {
      const readStorage = await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE
      );
      const writeStorage =
        Platform.Version < 30
          ? await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE)
          : true;
      hasStorage = readStorage && writeStorage;
    }
  } catch {
    // If check fails, default to permissive
  }

  return {
    hasNotificationPermission: hasNotification,
    hasStoragePermission: hasStorage,
    isPermissionGranted: hasStorage,
  };
}

/**
 * Proactively requests all necessary Android permissions for Maglev.
 */
export async function requestMaglevPermissions(): Promise<PermissionStatus> {
  if (Platform.OS !== 'android') {
    return {
      hasNotificationPermission: true,
      hasStoragePermission: true,
      isPermissionGranted: true,
    };
  }

  let hasNotification = true;
  let hasStorage = true;

  try {
    const permissionsToRequest: any[] = [];

    if (Platform.Version >= 33) {
      permissionsToRequest.push(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    }

    if (Platform.Version < 33) {
      permissionsToRequest.push(PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE);
      if (Platform.Version < 30) {
        permissionsToRequest.push(PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE);
      }
    }

    if (permissionsToRequest.length > 0) {
      const results = await PermissionsAndroid.requestMultiple(permissionsToRequest);

      if (Platform.Version >= 33) {
        hasNotification =
          results[PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS] ===
          PermissionsAndroid.RESULTS.GRANTED;
      }

      if (Platform.Version < 33) {
        const readGranted =
          results[PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE] ===
          PermissionsAndroid.RESULTS.GRANTED;
        const writeGranted =
          Platform.Version < 30
            ? results[PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE] ===
              PermissionsAndroid.RESULTS.GRANTED
            : true;
        hasStorage = readGranted && writeGranted;
      }
    }
  } catch {
    // Permission request handled gracefully
  }

  return {
    hasNotificationPermission: hasNotification,
    hasStoragePermission: hasStorage,
    isPermissionGranted: hasStorage,
  };
}
