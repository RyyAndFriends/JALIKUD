import { NativeTabs } from 'expo-router/unstable-native-tabs';

const STAFF_TABS = [
  { name: 'orders', label: 'Orders', icon: require('@/assets/images/tabIcons/orders.png') },
  { name: 'menu', label: 'Menu Status', icon: require('@/assets/images/tabIcons/menu.png') },
  { name: 'activity', label: 'Activity', icon: require('@/assets/images/tabIcons/activity.png') },
  { name: 'riders', label: 'Riders', icon: require('@/assets/images/tabIcons/orders.png') },
  { name: 'settings', label: 'Settings', icon: require('@/assets/images/tabIcons/more.png') },
] as const;

export default function StaffTabs() {
  return (
    <NativeTabs
      backgroundColor="#FFFFFF"
      iconColor={{ default: '#8E8E93', selected: '#DC2626' }}
      labelStyle={{ color: '#6B6B72', fontWeight: '600' }}
      labelVisibilityMode="labeled"
      indicatorColor="rgba(220, 38, 38, 0.12)"
      rippleColor="rgba(220, 38, 38, 0.12)">
      {STAFF_TABS.map((tab) => (
        <NativeTabs.Trigger key={tab.name} name={tab.name}>
          <NativeTabs.Trigger.Label>{tab.label}</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon src={tab.icon} />
        </NativeTabs.Trigger>
      ))}
    </NativeTabs>
  );
}
