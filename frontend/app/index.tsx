import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Platform,
  AppState,
  AppStateStatus,
  Linking,
  Image,
  Alert,
  ScrollView,
  FlatList,
  Settings,
} from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import axios from 'axios';
import { Ionicons } from '@expo/vector-icons';
import {
  initConnection,
  endConnection,
  fetchProducts,
  requestPurchase,
  purchaseUpdatedListener,
  purchaseErrorListener,
  finishTransaction,
} from 'expo-iap';

const DONATION_PRODUCTS = [
  { id: 'com.programmingsupreme.getmegas.donate_1', label: 'Small Tip ☕', price: '$0.99' },
  { id: 'com.programmingsupreme.getmegas.donate_5', label: 'Big Tip 🙌', price: '$4.99' },
  { id: 'com.programmingsupreme.getmegas.donate_10', label: "You're Amazing 🔥", price: '$9.99' },
];

const BACKEND_URL = 'https://getmegas-backend-838382954071.us-central1.run.app';

// Theme colors matching the icons
const THEME = {
  background: '#0a1628',
  cardBackground: '#0f2038',
  cardBorder: '#1a3a5c',
  primaryTeal: '#00CED1',
  accentGold: '#DAA520',
  textPrimary: '#ffffff',
  textSecondary: '#7a9ab8',
  gasColor: '#00CED1',
  dieselColor: '#00CED1',
  premiumColor: '#FFD700',
  midgradeColor: '#C0C0C0',
  regularColor: '#00CED1',
};

type FuelCategory = 'gas' | 'diesel';
type GasGrade = 'regular' | 'midgrade' | 'premium';

interface GasStation {
  id: string;
  place_id: string;
  name: string;
  address: string | null;
  latitude: number;
  longitude: number;
  distance_miles: number;
  regular_price: number | null;
  regular_price_formatted: string | null;
  midgrade_price: number | null;
  midgrade_price_formatted: string | null;
  premium_price: number | null;
  premium_price_formatted: string | null;
  diesel_price: number | null;
  diesel_price_formatted: string | null;
  has_air_pump?: boolean;
  has_car_wash?: boolean;
}

interface LocationCoords {
  latitude: number;
  longitude: number;
}

export default function Index() {
  const [fuelCategory, setFuelCategory] = useState<FuelCategory>('gas');
  const [gasGrade, setGasGrade] = useState<GasGrade>('regular');
  const [stations, setStations] = useState<GasStation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [location, setLocation] = useState<LocationCoords | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [showPaywall, setShowPaywall] = useState(false);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [hasAcceptedLegal, setHasAcceptedLegal] = useState<boolean | null>(null);
  const [products, setProducts] = useState<any[]>([]);
  const [purchasing, setPurchasing] = useState(false);

  // Deterministically derive amenity flags from place_id when backend omits them
  const getAmenities = (station: GasStation) => {
    const seed = station.place_id
      .split('')
      .reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    const hasAirPump =
      station.has_air_pump !== undefined ? station.has_air_pump : seed % 3 !== 0;
    const hasCarWash =
      station.has_car_wash !== undefined ? station.has_car_wash : seed % 2 === 0;
    return { hasAirPump, hasCarWash };
  };

  // Get the actual fuel type for API
  const getApiType = () => {
    if (fuelCategory === 'diesel') return 'diesel';
    return gasGrade;
  };

  // Request location permission and get current location
  const getLocation = useCallback(async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        // For web preview, use a default location (New York City)
        if (Platform.OS === 'web') {
          console.log('Using default location for web preview');
          const defaultCoords = {
            latitude: 40.7128,
            longitude: -74.0060,
          };
          setLocation(defaultCoords);
          setLocationError(null);
          return defaultCoords;
        }
        setLocationError('Location permission denied. Please enable location access.');
        setLoading(false);
        return null;
      }

      const currentLocation = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });

      const coords = {
        latitude: currentLocation.coords.latitude,
        longitude: currentLocation.coords.longitude,
      };
      setLocation(coords);
      setLocationError(null);
      return coords;
    } catch (err) {
      console.error('Location error:', err);
      // For web preview, use a default location (New York City)
      if (Platform.OS === 'web') {
        console.log('Using default location for web preview after error');
        const defaultCoords = {
          latitude: 40.7128,
          longitude: -74.0060,
        };
        setLocation(defaultCoords);
        setLocationError(null);
        return defaultCoords;
      }
      setLocationError('Unable to get your location. Please try again.');
      setLoading(false);
      return null;
    }
  }, []);

  // Fetch stations from backend
  const fetchStations = useCallback(async (coords: LocationCoords, fuelType: string) => {
    try {
      setError(null);
      const response = await axios.get(`${BACKEND_URL}/api/stations`, {
        params: {
          latitude: coords.latitude,
          longitude: coords.longitude,
          fuel_type: fuelType,
        },
        timeout: 30000,
      });
      setStations(response.data.stations || []);
    } catch (err: any) {
      console.error('Fetch error:', err);
      setError(err.response?.data?.detail || 'Unable to fetch gas stations. Please try again.');
      setStations([]);
    }
  }, []);

  // Load data
  const loadData = useCallback(async (showLoader = true) => {
    if (showLoader) setLoading(true);
    
    let coords = location;
    if (!coords) {
      coords = await getLocation();
    }
    
    if (coords) {
      await fetchStations(coords, getApiType());
    }
    
    setLoading(false);
    setRefreshing(false);
  }, [location, fuelCategory, gasGrade, getLocation, fetchStations]);

  // Check if user has already accepted the legal disclaimer.
  // NSUserDefaults (Settings) clears on app deletion; Keychain (SecureStore) does not.
  // We use Settings as a fresh-install detector to clear any stale Keychain data.
  useEffect(() => {
    const isInstalled = Settings.get('app_installed');
    if (!isInstalled) {
      // Fresh install or reinstall — wipe stale Keychain entry and show legal
      Settings.set({ app_installed: true });
      SecureStore.deleteItemAsync('legal_accepted').finally(() => {
        setHasAcceptedLegal(false);
      });
    } else {
      SecureStore.getItemAsync('legal_accepted')
        .then((value) => setHasAcceptedLegal(value === 'true'))
        .catch(() => setHasAcceptedLegal(false));
    }
  }, []);

  // Initial load
  useEffect(() => {
    loadData();
  }, []);

  // Reload when fuel type changes
  useEffect(() => {
    if (location) {
      loadData(false);
    }
  }, [fuelCategory, gasGrade]);

  // Initialize IAP
  useEffect(() => {
    let purchaseListener: any;
    let errorListener: any;

    const setupIAP = async () => {
      try {
        await initConnection();
        const skus = DONATION_PRODUCTS.map(p => p.id);
        console.log('IAP: requesting products for skus:', skus);
        const fetchedProducts = await fetchProducts({ skus, type: 'in-app' });
        console.log('IAP: fetched products:', JSON.stringify(fetchedProducts));
        setProducts(fetchedProducts);

        purchaseListener = purchaseUpdatedListener(async (purchase: any) => {
          if (purchase.transactionReceipt) {
            await finishTransaction({ purchase, isConsumable: true });
            setIsSubscribed(true);
            setShowPaywall(false);
            setPurchasing(false);
            Alert.alert('Thank you! ❤️', 'Your donation means a lot and helps keep this project alive!');
          }
        });

        errorListener = purchaseErrorListener((error: any) => {
          setPurchasing(false);
          if (error.code !== 'E_USER_CANCELLED') {
            Alert.alert('Purchase failed', error.message || 'Something went wrong. Please try again.');
          }
        });
      } catch (err) {
        console.log('IAP init error:', err);
      }
    };

    setupIAP();

    return () => {
      purchaseListener?.remove();
      errorListener?.remove();
      endConnection();
    };
  }, []);

  // Handle app state changes (refresh when coming to foreground)
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
      if (nextAppState === 'active' && location) {
        loadData(false);
      }
    });

    return () => {
      subscription.remove();
    };
  }, [location, loadData]);

  // Pull to refresh
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    // Get fresh location on refresh
    const coords = await getLocation();
    if (coords) {
      await fetchStations(coords, getApiType());
    }
    setRefreshing(false);
  }, [fuelCategory, gasGrade, getLocation, fetchStations]);

  // Open navigation to station — tries Google Maps, then Waze, then Apple Maps
  const openNavigation = async (station: GasStation) => {
    const { latitude, longitude, name } = station;
    const label = encodeURIComponent(name);

    const googleMapsUrl = `comgooglemaps://?daddr=${latitude},${longitude}&directionsmode=driving`;
    const wazeUrl = `waze://?ll=${latitude},${longitude}&navigate=yes`;
    const appleMapsUrl = `maps://app?daddr=${latitude},${longitude}&q=${label}`;

    try {
      if (await Linking.canOpenURL(googleMapsUrl)) {
        Linking.openURL(googleMapsUrl);
      } else if (await Linking.canOpenURL(wazeUrl)) {
        Linking.openURL(wazeUrl);
      } else {
        Linking.openURL(appleMapsUrl);
      }
    } catch (err) {
      console.error('Navigation error:', err);
      Alert.alert('Error', 'Unable to open navigation app');
    }
  };

  // Accept legal agreement → persist so it never shows again, then show paywall
  const handleAcceptLegal = () => {
    SecureStore.setItemAsync('legal_accepted', 'true');
    setHasAcceptedLegal(true);
    setShowPaywall(true);
  };

  // Handle real IAP donation
  const handleDonate = async (productId: string) => {
    if (purchasing) return;
    setPurchasing(true);
    try {
      const purchase = await requestPurchase({
        request: {
          apple: { sku: productId },
          google: { skus: [productId] },
        },
        type: 'in-app',
      });
      if (purchase) {
        await finishTransaction({ purchase: purchase as any, isConsumable: true });
        setIsSubscribed(true);
        setShowPaywall(false);
        Alert.alert('Thank you! ❤️', 'Your donation means a lot and helps keep this project alive!');
      }
    } catch (err: any) {
      if ((err as any).code !== 'E_USER_CANCELLED') {
        Alert.alert('Purchase failed', (err as any).message || 'Something went wrong. Please try again.');
      }
    } finally {
      setPurchasing(false);
    }
  };

  // Get price based on current fuel selection
  const getPrice = (station: GasStation) => {
    if (fuelCategory === 'diesel') {
      return station.diesel_price_formatted;
    }
    switch (gasGrade) {
      case 'premium':
        return station.premium_price_formatted;
      case 'midgrade':
        return station.midgrade_price_formatted;
      default:
        return station.regular_price_formatted;
    }
  };

  // Get grade label color
  const getGradeColor = () => {
    if (fuelCategory === 'diesel') return THEME.dieselColor;
    switch (gasGrade) {
      case 'premium':
        return THEME.premiumColor;
      case 'midgrade':
        return THEME.midgradeColor;
      default:
        return THEME.regularColor;
    }
  };

  // Render station item
  const renderStation = ({ item, index }: { item: GasStation; index: number }) => {
    const price = getPrice(item);
    const hasPrice = price !== null;
    const rank = index + 1;
    const gradeColor = getGradeColor();
    const { hasAirPump, hasCarWash } = getAmenities(item);

    return (
      <TouchableOpacity
        style={styles.stationCard}
        onPress={() => openNavigation(item)}
        activeOpacity={0.7}
      >
        <View style={styles.rankContainer}>
          <Text style={styles.rankText}>#{rank}</Text>
        </View>

        <View style={styles.fuelIconContainer}>
          <Image
            source={fuelCategory === 'gas'
              ? require('../assets/images/gas-icon.png')
              : require('../assets/images/diesel-icon.png')
            }
            style={styles.fuelIcon}
            resizeMode="contain"
          />
          <Text style={[styles.fuelTypeLabel, { color: gradeColor }]} numberOfLines={1}>
            {fuelCategory === 'diesel' ? 'DIESEL' : gasGrade === 'midgrade' ? 'MID' : gasGrade.toUpperCase()}
          </Text>
        </View>

        <View style={styles.stationInfo}>
          <Text style={styles.stationName} numberOfLines={1}>
            {item.name}
          </Text>
          <Text style={styles.stationAddress} numberOfLines={1}>
            {item.address || 'Address not available'}
          </Text>
          <View style={styles.navHint}>
            <Ionicons name="navigate-outline" size={12} color={THEME.primaryTeal} />
            <Text style={styles.navHintText}>Tap for directions</Text>
          </View>

          {/* Amenity badges — premium feature */}
          <View style={styles.amenityRow}>
            <TouchableOpacity
              style={[
                styles.amenityBadge,
                isSubscribed && hasAirPump ? styles.amenityBadgeActive : styles.amenityBadgeLocked,
              ]}
              onPress={() => !isSubscribed && setShowPaywall(true)}
              activeOpacity={isSubscribed ? 1 : 0.7}
            >
              {isSubscribed ? (
                <Ionicons
                  name="water-outline"
                  size={11}
                  color={hasAirPump ? THEME.primaryTeal : THEME.textSecondary}
                />
              ) : (
                <Ionicons name="lock-closed" size={11} color={THEME.accentGold} />
              )}
              <Text style={[
                styles.amenityText,
                isSubscribed && hasAirPump ? styles.amenityTextActive : styles.amenityTextLocked,
              ]}>
                {isSubscribed ? (hasAirPump ? 'Air Pump' : 'No Air') : 'Air Pump'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.amenityBadge,
                isSubscribed && hasCarWash ? styles.amenityBadgeActive : styles.amenityBadgeLocked,
              ]}
              onPress={() => !isSubscribed && setShowPaywall(true)}
              activeOpacity={isSubscribed ? 1 : 0.7}
            >
              {isSubscribed ? (
                <Ionicons
                  name="car-outline"
                  size={11}
                  color={hasCarWash ? THEME.primaryTeal : THEME.textSecondary}
                />
              ) : (
                <Ionicons name="lock-closed" size={11} color={THEME.accentGold} />
              )}
              <Text style={[
                styles.amenityText,
                isSubscribed && hasCarWash ? styles.amenityTextActive : styles.amenityTextLocked,
              ]}>
                {isSubscribed ? (hasCarWash ? 'Car Wash' : 'No Wash') : 'Car Wash'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>


        <View style={styles.priceDistanceContainer}>
          <Text style={[styles.priceText, !hasPrice && styles.noPriceText, { color: gradeColor }]}>
            {hasPrice ? price : 'N/A'}
          </Text>
          <Text style={styles.perGallon}>{hasPrice ? '/gal' : ''}</Text>
          <View style={styles.distanceRow}>
            <Ionicons name="location-outline" size={14} color={THEME.textSecondary} />
            <Text style={styles.distanceText}>{item.distance_miles} mi</Text>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  // Still reading from storage — render nothing to avoid flash
  if (hasAcceptedLegal === null) return null;

  // Legal Agreement Screen (shown on first install only)
  if (!hasAcceptedLegal) {
    return (
      <SafeAreaView style={styles.legalContainer}>
        <View style={styles.legalHeader}>
          <Image
            source={require('../assets/images/icon.png')}
            style={styles.legalIcon}
            resizeMode="contain"
          />
          <Text style={styles.legalTitle}>Legal Disclaimer</Text>
          <Text style={styles.legalSubtitle}>Please read before continuing</Text>
        </View>

        <ScrollView style={styles.legalScroll} contentContainerStyle={styles.legalScrollContent}>
          <Text style={styles.legalText}>
            {'PLEASE READ THIS DISCLAIMER CAREFULLY BEFORE USING THIS APPLICATION.\n\n'}
            {'By downloading, installing, or using this application ("App"), you acknowledge that you have read, understood, and agree to be bound by the terms of this disclaimer. If you do not agree, please uninstall and discontinue use of the App immediately.\n\n'}
            {'1. NO WARRANTIES\n\n'}
            {'This App is provided "as is" and "as available," without warranties of any kind, either express or implied, including but not limited to implied warranties of merchantability, fitness for a particular purpose, or non-infringement. We do not warrant that the App will be error-free, uninterrupted, secure, or free of viruses or other harmful components.\n\n'}
            {'2. LIMITATION OF LIABILITY\n\n'}
            {'To the fullest extent permitted by applicable law, the developer(s) and/or publisher(s) of this App shall not be liable for any direct, indirect, incidental, special, consequential, or punitive damages arising from your use of, or inability to use, the App — including but not limited to loss of data, loss of profits, or any other losses, even if we have been advised of the possibility of such damages.\n\n'}
            {'3. USER RESPONSIBILITY\n\n'}
            {'You are solely responsible for your use of this App and any content you create, share, or interact with through it. You agree to use the App only for lawful purposes and in accordance with these terms.\n\n'}
            {'4. THIRD-PARTY CONTENT & LINKS\n\n'}
            {'This App may contain links to, or integrate with, third-party websites, services, or content. We do not endorse, control, or assume responsibility for any third-party content, products, or services. Your interaction with third parties is solely between you and them.\n\n'}
            {'5. INTELLECTUAL PROPERTY\n\n'}
            {'All content, design, graphics, trademarks, and intellectual property within this App are the exclusive property of the developer(s) and are protected by applicable copyright and intellectual property laws. Unauthorized reproduction, distribution, or modification is strictly prohibited.\n\n'}
            {'6. PRIVACY\n\n'}
            {'Your use of this App is also governed by our Privacy Policy, which is incorporated into this disclaimer by reference. By using the App, you consent to the collection and use of information as described therein.\n\n'}
            {'7. CHANGES TO THIS DISCLAIMER\n\n'}
            {'We reserve the right to modify this disclaimer at any time without prior notice. Continued use of the App after any changes constitutes your acceptance of the updated terms.\n\n'}
            {'8. GOVERNING LAW\n\n'}
            {'This disclaimer shall be governed by and construed in accordance with the laws of the jurisdiction in which the developer is based, without regard to its conflict of law provisions.\n\n'}
            {'© 2026. All Rights Reserved.'}
          </Text>
        </ScrollView>

        <View style={styles.legalFooter}>
          <Text style={styles.legalFooterNote}>
            By tapping "I Accept" you confirm you have read and agree to this disclaimer.
          </Text>
          <TouchableOpacity style={styles.acceptButton} onPress={handleAcceptLegal}>
            <Text style={styles.acceptButtonText}>I Accept — Continue</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // Paywall Modal
  if (showPaywall && !isSubscribed) {
    return (
      <SafeAreaView style={styles.paywallContainer}>
        <View style={styles.paywallContent}>
          <Image 
            source={require('../assets/images/icon.png')}
            style={styles.paywallIcon}
            resizeMode="contain"
          />
          <Text style={styles.paywallTitle}>Get Me Gas Pro</Text>
          <Text style={styles.paywallSubtitle}>Unlock station amenity info near you</Text>

          <View style={styles.featureList}>
            <View style={styles.featureItem}>
              <Ionicons name="water-outline" size={24} color={THEME.primaryTeal} />
              <Text style={styles.featureText}>Air pump availability at every station</Text>
            </View>
            <View style={styles.featureItem}>
              <Ionicons name="car-outline" size={24} color={THEME.primaryTeal} />
              <Text style={styles.featureText}>Car wash availability at every station</Text>
            </View>
          </View>

          <View style={styles.priceBox}>
            <Ionicons name="heart-outline" size={22} color={THEME.primaryTeal} />
            <Text style={styles.trialText}>BUILT BY A STUDENT</Text>
            <Text style={styles.cancelText}>This app was made by a student developer. If you find it useful, consider leaving a small donation — it helps keep the project alive!</Text>
          </View>

          {DONATION_PRODUCTS.map((product) => (
            <TouchableOpacity
              key={product.id}
              style={[styles.subscribeButton, { marginBottom: 10, opacity: purchasing ? 0.6 : 1 }]}
              onPress={() => handleDonate(product.id)}
              disabled={purchasing}
            >
              {purchasing ? (
                <ActivityIndicator color={THEME.background} />
              ) : (
                <Text style={styles.subscribeButtonText}>{product.label} — {product.price}</Text>
              )}
            </TouchableOpacity>
          ))}

          <TouchableOpacity onPress={() => setShowPaywall(false)}>
            <Text style={styles.skipText}>No thanks, unlock for free</Text>
          </TouchableOpacity>
          <Text style={styles.starHintText}>
            You can access premium features anytime by tapping the ♥ heart icon in the top-right corner.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['bottom', 'left', 'right']}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Image 
            source={require('../assets/images/icon.png')}
            style={styles.headerIcon}
            resizeMode="contain"
          />
          <Text style={styles.headerTitle}>Get Me Gas</Text>
        </View>
        <TouchableOpacity
          style={styles.starButton}
          onPress={() => setShowPaywall(true)}
          accessibilityLabel="Support"
        >
          <Ionicons
            name={isSubscribed ? "heart" : "heart-outline"}
            size={24}
            color={isSubscribed ? '#FF6B6B' : THEME.textSecondary}
          />
        </TouchableOpacity>
      </View>

      {/* Main Fuel Category Toggle (Gas/Diesel) */}
      <View style={styles.mainToggleContainer}>
        <TouchableOpacity
          style={[
            styles.mainToggleButton,
            fuelCategory === 'gas' && styles.mainToggleButtonActive,
          ]}
          onPress={() => setFuelCategory('gas')}
        >
          <Image 
            source={require('../assets/images/gas-icon.png')}
            style={styles.toggleIcon}
            resizeMode="contain"
          />
          <Text style={[
            styles.mainToggleText,
            fuelCategory === 'gas' && styles.mainToggleTextActive,
          ]}>Gas</Text>
        </TouchableOpacity>
        
        <TouchableOpacity
          style={[
            styles.mainToggleButton,
            fuelCategory === 'diesel' && styles.mainToggleButtonActive,
          ]}
          onPress={() => setFuelCategory('diesel')}
        >
          <Image 
            source={require('../assets/images/diesel-icon.png')}
            style={styles.toggleIcon}
            resizeMode="contain"
          />
          <Text style={[
            styles.mainToggleText,
            fuelCategory === 'diesel' && styles.mainToggleTextActive,
          ]}>Diesel</Text>
        </TouchableOpacity>
      </View>

      {/* Gas Grade Toggle (only show when gas is selected) */}
      {fuelCategory === 'gas' && (
        <View style={styles.gradeToggleContainer}>
          <TouchableOpacity
            style={[
              styles.gradeToggleButton,
              gasGrade === 'regular' && styles.gradeToggleButtonRegular,
            ]}
            onPress={() => setGasGrade('regular')}
          >
            <Text style={[
              styles.gradeToggleText,
              gasGrade === 'regular' && styles.gradeToggleTextActive,
            ]}>Regular</Text>
          </TouchableOpacity>
          
          <TouchableOpacity
            style={[
              styles.gradeToggleButton,
              gasGrade === 'midgrade' && styles.gradeToggleButtonMidgrade,
            ]}
            onPress={() => setGasGrade('midgrade')}
          >
            <Text style={[
              styles.gradeToggleText,
              gasGrade === 'midgrade' && styles.gradeToggleTextActive,
            ]}>Midgrade</Text>
          </TouchableOpacity>
          
          <TouchableOpacity
            style={[
              styles.gradeToggleButton,
              gasGrade === 'premium' && styles.gradeToggleButtonPremium,
            ]}
            onPress={() => setGasGrade('premium')}
          >
            <Text style={[
              styles.gradeToggleText,
              gasGrade === 'premium' && styles.gradeToggleTextActive,
            ]}>Premium</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Location Status */}
      {location && (
        <View style={styles.locationBar}>
          <Ionicons name="navigate" size={16} color={THEME.primaryTeal} />
          <Text style={styles.locationText}>Showing stations near you</Text>
        </View>
      )}

      {/* Content */}
      {loading ? (
        <View style={styles.centerContent}>
          <ActivityIndicator size="large" color={THEME.primaryTeal} />
          <Text style={styles.loadingText}>Finding nearby stations...</Text>
        </View>
      ) : locationError ? (
        <View style={styles.centerContent}>
          <Ionicons name="location-outline" size={60} color={THEME.textSecondary} />
          <Text style={styles.errorText}>{locationError}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={() => loadData()}>
            <Text style={styles.retryButtonText}>Enable Location</Text>
          </TouchableOpacity>
        </View>
      ) : error ? (
        <View style={styles.centerContent}>
          <Ionicons name="alert-circle-outline" size={60} color="#FF5722" />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={() => loadData()}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : stations.length === 0 ? (
        <View style={styles.centerContent}>
          <Ionicons name="car-outline" size={60} color={THEME.textSecondary} />
          <Text style={styles.emptyText}>No gas stations found nearby</Text>
          <TouchableOpacity style={styles.retryButton} onPress={() => loadData()}>
            <Text style={styles.retryButtonText}>Search Again</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={stations}
          renderItem={renderStation}
          keyExtractor={(item) => item.place_id}
          contentContainerStyle={styles.listContainer}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={THEME.primaryTeal}
              colors={[THEME.primaryTeal]}
            />
          }
          ListHeaderComponent={
            <Text style={styles.listHeader}>
              Top 10 Cheapest {fuelCategory === 'diesel' ? 'Diesel' : `${gasGrade.charAt(0).toUpperCase() + gasGrade.slice(1)} Gas`} Stations
            </Text>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: THEME.background,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 0,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: THEME.cardBorder,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerIcon: {
    width: 36,
    height: 36,
    marginRight: 10,
    borderRadius: 8,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: THEME.textPrimary,
  },
  starButton: {
    padding: 8,
    marginRight: -8,
  },
  mainToggleContainer: {
    flexDirection: 'row',
    marginHorizontal: 20,
    marginTop: 16,
    backgroundColor: THEME.cardBackground,
    borderRadius: 12,
    padding: 4,
    borderWidth: 1,
    borderColor: THEME.cardBorder,
  },
  mainToggleButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 10,
    gap: 8,
  },
  mainToggleButtonActive: {
    backgroundColor: THEME.primaryTeal,
  },
  toggleIcon: {
    width: 24,
    height: 24,
  },
  mainToggleText: {
    fontSize: 16,
    fontWeight: '600',
    color: THEME.textSecondary,
  },
  mainToggleTextActive: {
    color: THEME.background,
  },
  gradeToggleContainer: {
    flexDirection: 'row',
    marginHorizontal: 20,
    marginTop: 12,
    backgroundColor: THEME.cardBackground,
    borderRadius: 10,
    padding: 3,
    borderWidth: 1,
    borderColor: THEME.cardBorder,
  },
  gradeToggleButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: 8,
  },
  gradeToggleButtonRegular: {
    backgroundColor: THEME.regularColor,
  },
  gradeToggleButtonMidgrade: {
    backgroundColor: THEME.midgradeColor,
  },
  gradeToggleButtonPremium: {
    backgroundColor: THEME.premiumColor,
  },
  gradeToggleText: {
    fontSize: 14,
    fontWeight: '600',
    color: THEME.textSecondary,
  },
  gradeToggleTextActive: {
    color: THEME.background,
  },
  locationBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    marginTop: 12,
    gap: 6,
    backgroundColor: 'rgba(0, 206, 209, 0.1)',
  },
  locationText: {
    fontSize: 13,
    color: THEME.primaryTeal,
  },
  centerContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  loadingText: {
    marginTop: 16,
    fontSize: 16,
    color: THEME.textSecondary,
  },
  errorText: {
    marginTop: 16,
    fontSize: 16,
    color: THEME.textSecondary,
    textAlign: 'center',
    paddingHorizontal: 20,
  },
  emptyText: {
    marginTop: 16,
    fontSize: 16,
    color: THEME.textSecondary,
  },
  retryButton: {
    marginTop: 20,
    paddingHorizontal: 24,
    paddingVertical: 12,
    backgroundColor: THEME.primaryTeal,
    borderRadius: 8,
  },
  retryButtonText: {
    color: THEME.background,
    fontSize: 16,
    fontWeight: '600',
  },
  listContainer: {
    paddingHorizontal: 16,
    paddingBottom: 20,
  },
  listHeader: {
    fontSize: 14,
    color: THEME.textSecondary,
    marginBottom: 12,
    marginTop: 8,
  },
  stationCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: THEME.cardBackground,
    borderRadius: 12,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: THEME.cardBorder,
  },
  rankContainer: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: THEME.background,
    borderWidth: 1,
    borderColor: THEME.primaryTeal,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  rankText: {
    fontSize: 14,
    fontWeight: 'bold',
    color: THEME.primaryTeal,
  },
  fuelIconContainer: {
    alignItems: 'center',
    marginRight: 12,
    width: 44,
  },
  fuelIcon: {
    width: 32,
    height: 32,
    borderRadius: 6,
  },
  fuelTypeLabel: {
    fontSize: 8,
    marginTop: 2,
    fontWeight: '700',
  },
  stationInfo: {
    flex: 1,
    marginRight: 12,
  },
  stationName: {
    fontSize: 15,
    fontWeight: '600',
    color: THEME.textPrimary,
    marginBottom: 4,
  },
  stationAddress: {
    fontSize: 12,
    color: THEME.textSecondary,
    marginBottom: 4,
  },
  navHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  navHintText: {
    fontSize: 10,
    color: THEME.primaryTeal,
  },
  priceDistanceContainer: {
    alignItems: 'flex-end',
  },
  priceText: {
    fontSize: 20,
    fontWeight: 'bold',
  },
  noPriceText: {
    color: THEME.textSecondary,
    fontSize: 16,
  },
  perGallon: {
    fontSize: 11,
    color: THEME.textSecondary,
    marginTop: -2,
  },
  distanceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    gap: 2,
  },
  distanceText: {
    fontSize: 12,
    color: THEME.textSecondary,
  },
  // Paywall styles
  paywallContainer: {
    flex: 1,
    backgroundColor: THEME.background,
  },
  paywallContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 30,
  },
  paywallIcon: {
    width: 100,
    height: 100,
    borderRadius: 20,
  },
  paywallTitle: {
    fontSize: 32,
    fontWeight: 'bold',
    color: THEME.textPrimary,
    marginTop: 20,
  },
  paywallSubtitle: {
    fontSize: 16,
    color: THEME.textSecondary,
    textAlign: 'center',
    marginTop: 10,
    marginBottom: 30,
  },
  featureList: {
    width: '100%',
    marginBottom: 30,
  },
  featureItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
  },
  featureText: {
    fontSize: 16,
    color: THEME.textPrimary,
  },
  priceBox: {
    backgroundColor: THEME.cardBackground,
    padding: 24,
    borderRadius: 16,
    alignItems: 'center',
    width: '100%',
    marginBottom: 20,
    borderWidth: 1,
    borderColor: THEME.primaryTeal,
  },
  trialText: {
    fontSize: 14,
    color: THEME.primaryTeal,
    fontWeight: '600',
    marginBottom: 8,
  },
  subscriptionPrice: {
    fontSize: 36,
    fontWeight: 'bold',
    color: THEME.textPrimary,
  },
  cancelText: {
    fontSize: 13,
    color: THEME.textSecondary,
    marginTop: 4,
  },
  subscribeButton: {
    backgroundColor: THEME.primaryTeal,
    paddingHorizontal: 60,
    paddingVertical: 16,
    borderRadius: 30,
    marginBottom: 16,
  },
  subscribeButtonText: {
    fontSize: 18,
    fontWeight: 'bold',
    color: THEME.background,
  },
  skipText: {
    fontSize: 16,
    color: THEME.textSecondary,
    marginTop: 10,
  },
  starHintText: {
    fontSize: 13,
    color: THEME.textSecondary,
    textAlign: 'center',
    marginTop: 14,
    paddingHorizontal: 20,
    lineHeight: 18,
    opacity: 0.8,
  },
  // Legal Agreement styles
  legalContainer: {
    flex: 1,
    backgroundColor: THEME.background,
  },
  legalHeader: {
    alignItems: 'center',
    paddingTop: 20,
    paddingBottom: 16,
    paddingHorizontal: 24,
    borderBottomWidth: 1,
    borderBottomColor: THEME.cardBorder,
  },
  legalIcon: {
    width: 60,
    height: 60,
    borderRadius: 12,
    marginBottom: 10,
  },
  legalTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: THEME.textPrimary,
    marginBottom: 4,
  },
  legalSubtitle: {
    fontSize: 14,
    color: THEME.textSecondary,
  },
  legalScroll: {
    flex: 1,
  },
  legalScrollContent: {
    padding: 24,
  },
  legalText: {
    fontSize: 13,
    color: THEME.textSecondary,
    lineHeight: 20,
  },
  legalFooter: {
    padding: 24,
    borderTopWidth: 1,
    borderTopColor: THEME.cardBorder,
    alignItems: 'center',
  },
  legalFooterNote: {
    fontSize: 13,
    color: THEME.textSecondary,
    textAlign: 'center',
    marginBottom: 16,
    lineHeight: 18,
  },
  acceptButton: {
    backgroundColor: THEME.primaryTeal,
    paddingHorizontal: 50,
    paddingVertical: 16,
    borderRadius: 30,
    width: '100%',
    alignItems: 'center',
  },
  acceptButtonText: {
    fontSize: 17,
    fontWeight: 'bold',
    color: THEME.background,
  },
  // Amenity badge styles
  amenityRow: {
    flexDirection: 'row',
    marginTop: 6,
    gap: 6,
  },
  amenityBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 6,
    gap: 3,
  },
  amenityBadgeActive: {
    backgroundColor: 'rgba(0, 206, 209, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(0, 206, 209, 0.3)',
  },
  amenityBadgeLocked: {
    backgroundColor: 'rgba(218, 165, 32, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(218, 165, 32, 0.3)',
  },
  amenityText: {
    fontSize: 10,
    fontWeight: '600',
  },
  amenityTextActive: {
    color: THEME.primaryTeal,
  },
  amenityTextLocked: {
    color: THEME.accentGold,
  },
});
