const { withEntitlementsPlist } = require('expo/config-plugins');

/**
 * expo-notifications' config plugin adds `aps-environment`, and Expo applies that plugin
 * automatically because the package is installed — listing or unlisting it in app.json
 * makes no difference. Free personal Apple teams cannot provision the Push Notifications
 * capability, so that entitlement makes the app fail to sign for a physical device.
 *
 * Amelia only schedules LOCAL notifications, which need no entitlement. This strips it
 * back out after the notifications plugin runs, so `expo prebuild` stays reproducible.
 *
 * Delete this plugin if the team moves to a paid Apple Developer account and wants push.
 */
module.exports = function withNoPushEntitlement(config) {
  return withEntitlementsPlist(config, (modConfig) => {
    delete modConfig.modResults['aps-environment'];
    return modConfig;
  });
};
