import {
  DarkTheme,
  DefaultTheme,
  Stack,
  ThemeProvider,
  useRouter,
  useSegments,
} from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';

import { SplashOverlay } from '@/components/splash-overlay';
import { AuthProvider, routeForRole, useAuth } from '@/context/auth-context';
import { CustomerOrderProvider } from '@/context/customer-order-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

// Preventing auto-hide can reject (e.g. version/Go mismatch). A rejection
// here must never crash startup and trap the native splash on screen.
SplashScreen.preventAutoHideAsync().catch(() => undefined);

function AuthRouter() {
  const router = useRouter();
  const segments = useSegments();
  const { loading, user } = useAuth();

  useEffect(() => {
    if (loading) return;

    // Expo's generated segment union can lag newly added route files until the
    // dev server regenerates .expo/types; runtime segment values are strings.
    const root = segments[0] as string | undefined;
    const isPublic = root === 'login' || root === 'register';
    if (!user && !isPublic) {
      router.replace('/login');
    } else if (user && isPublic) {
      router.replace(routeForRole(user.role));
    } else if (user) {
      const allowedRoot = user.role === 'rider' ? 'rider' : user.role === 'customer' ? '(tabs)' : 'staff';
      const isCustomerAccountScreen = user.role === 'customer' && (root === 'account' || root === 'addresses');
      if (root !== allowedRoot && !isCustomerAccountScreen) router.replace(routeForRole(user.role));
    }
  }, [loading, router, segments, user]);

  return null;
}

export default function RootLayout() {
  const colorScheme = useColorScheme();
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <AuthProvider>
          <AuthRouter />
          <CustomerOrderProvider>
            <SplashOverlay />
            <Stack screenOptions={{ headerShown: false }} initialRouteName="login">
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="staff" />
              <Stack.Screen name="rider" />
              <Stack.Screen name="login" />
              <Stack.Screen name="register" />
              <Stack.Screen name="account" />
              <Stack.Screen name="addresses" />
            </Stack>
          </CustomerOrderProvider>
        </AuthProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
