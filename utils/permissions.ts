import { Platform, PermissionsAndroid } from 'react-native';
import { maglevEngine } from 'maglev-engine';

export interface PermissionStatus {
  hasNotificationPermission: boolean;
  hasStoragePermission: boolean;
  isPermissionGranted: boolean;
  isAllFilesAccessGranted: boolean;
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
      isAllFilesAccessGranted: true,
    };
  }

  let hasNotification = true;
  let hasStorage = false;
  let hasAllFiles = true;

  try {
    // Check All Files Access (Android 11+ / API 30+)
    if (typeof Platform.Version === 'number' && Platform.Version >= 30) {
      hasAllFiles = maglevEngine.isAllFilesAccessGranted();
    }

    // Android 13+ (API 33+) requires POST_NOTIFICATIONS runtime permission
    if (typeof Platform.Version === 'number' && Platform.Version >= 33) {
      hasNotification = await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
      );

      // On Android 13+, check granular media permissions or broad storage
      const checkImages = await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES
      );
      const checkVideo = await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.READ_MEDIA_VIDEO
      );
      const checkAudio = await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.READ_MEDIA_AUDIO
      );

      // Storage is satisfied if all files access is granted OR any media permission is granted
      hasStorage = hasAllFiles || checkImages || checkVideo || checkAudio;
    } else {
      // Android 12 (API 32) and below checks standard external storage permissions
      const readStorage = await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE
      );
      const writeStorage =
        typeof Platform.Version === 'number' && Platform.Version < 30
          ? await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE)
          : true;
      hasStorage = hasAllFiles || (readStorage && writeStorage);
    }
  } catch {
    // If check fails, default to permissive fallback
    hasStorage = true;
  }

  return {
    hasNotificationPermission: hasNotification,
    hasStoragePermission: hasStorage,
    isPermissionGranted: hasStorage,
    isAllFilesAccessGranted: hasAllFiles,
  };
}

/**
 * Proactively requests all necessary Android permissions for Maglev.
 * Automatically handles Android 13+ (API 33+), Android 11-12 (API 30-32), and Android <= 10.
 */
export async function requestMaglevPermissions(): Promise<PermissionStatus> {
  if (Platform.OS !== 'android') {
    return {
      hasNotificationPermission: true,
      hasStoragePermission: true,
      isPermissionGranted: true,
      isAllFilesAccessGranted: true,
    };
  }

  let hasNotification = true;
  let hasStorage = false;
  let hasAllFiles = true;

  try {
    const permissionsToRequest: any[] = [];

    if (typeof Platform.Version === 'number' && Platform.Version >= 33) {
      // Android 13+ (API 33+) notification & granular media permissions
      permissionsToRequest.push(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
        PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES,
        PermissionsAndroid.PERMISSIONS.READ_MEDIA_VIDEO,
        PermissionsAndroid.PERMISSIONS.READ_MEDIA_AUDIO
      );
    } else {
      // Android <= 12 storage permissions
      permissionsToRequest.push(PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE);
      if (typeof Platform.Version === 'number' && Platform.Version < 30) {
        permissionsToRequest.push(PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE);
      }
    }

    if (permissionsToRequest.length > 0) {
      const results = await PermissionsAndroid.requestMultiple(permissionsToRequest);

      if (typeof Platform.Version === 'number' && Platform.Version >= 33) {
        hasNotification =
          results[PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS] ===
          PermissionsAndroid.RESULTS.GRANTED;

        const imgGranted =
          results[PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES] ===
          PermissionsAndroid.RESULTS.GRANTED;
        const vidGranted =
          results[PermissionsAndroid.PERMISSIONS.READ_MEDIA_VIDEO] ===
          PermissionsAndroid.RESULTS.GRANTED;
        const audGranted =
          results[PermissionsAndroid.PERMISSIONS.READ_MEDIA_AUDIO] ===
          PermissionsAndroid.RESULTS.GRANTED;

        hasStorage = imgGranted || vidGranted || audGranted;
      } else {
        const readGranted =
          results[PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE] ===
          PermissionsAndroid.RESULTS.GRANTED;
        const writeGranted =
          typeof Platform.Version === 'number' && Platform.Version < 30
            ? results[PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE] ===
              PermissionsAndroid.RESULTS.GRANTED
            : true;
        hasStorage = readGranted && writeGranted;
      }
    }

    // Check All Files Access
    if (typeof Platform.Version === 'number' && Platform.Version >= 30) {
      hasAllFiles = maglevEngine.isAllFilesAccessGranted();
      if (hasAllFiles) {
        hasStorage = true;
      }
    }
  } catch {
    // Permission request handled gracefully
  }

  return {
    hasNotificationPermission: hasNotification,
    hasStoragePermission: hasStorage,
    isPermissionGranted: hasStorage,
    isAllFilesAccessGranted: hasAllFiles,
  };
}

/**
 * Requests All Files Access on Android 11+ (API 30+) via system settings.
 */
export async function requestAllFilesAccess(): Promise<boolean> {
  if (Platform.OS !== 'android' || (typeof Platform.Version === 'number' && Platform.Version < 30)) {
    return true;
  }
  return await maglevEngine.requestAllFilesAccess();
}
