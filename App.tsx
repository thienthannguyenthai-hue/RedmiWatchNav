import React, { useEffect, useState, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  Alert,
  SafeAreaView,
  Keyboard,
  Platform,
  Modal,
  ScrollView,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import MapView, { Marker, Polyline } from 'react-native-maps';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as Clipboard from 'expo-clipboard';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  Coordinate,
  NavStep,
  PlaceSuggestion,
  parseGoogleMapsInput,
  searchPlaces,
  fetchRoute,
  formatDistance,
  getDistanceMeters,
} from './src/navUtils';
import {
  BACKGROUND_NAV_TASK,
  STORAGE_NAV_STATE_KEY,
  PersistedNavState,
  sendWatchNotification,
  processLocationUpdate,
} from './src/backgroundNavTask';

export default function App() {
  const mapRef = useRef<MapView | null>(null);
  const fgSubRef = useRef<Location.LocationSubscription | null>(null);

  const [currentLocation, setCurrentLocation] = useState<Coordinate | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [loading, setLoading] = useState(false);

  const [destination, setDestination] = useState<{
    name: string;
    coordinate: Coordinate;
  } | null>(null);
  const [routePolyline, setRoutePolyline] = useState<Coordinate[]>([]);
  const [steps, setSteps] = useState<NavStep[]>([]);
  const [currentStepIdx, setCurrentStepIdx] = useState<number>(1);
  const [distToNext, setDistToNext] = useState<number | null>(null);
  const [totalDistance, setTotalDistance] = useState<number>(0);

  const [isNavigating, setIsNavigating] = useState(false);
  const [showGuideModal, setShowGuideModal] = useState(false);

  // Request permissions and initial GPS location on startup
  useEffect(() => {
    (async () => {
      const { status: notifStatus } =
        await Notifications.requestPermissionsAsync();
      if (notifStatus !== 'granted') {
        Alert.alert(
          'Cần quyền Thông báo',
          'Vui lòng bật quyền Thông báo để iPhone có thể đẩy chỉ đường sang Redmi Watch 5.'
        );
      }

      const { status: fgStatus } =
        await Location.requestForegroundPermissionsAsync();
      if (fgStatus === 'granted') {
        const loc = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        setCurrentLocation({
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
        });
      }
    })();

    return () => {
      if (fgSubRef.current) {
        fgSubRef.current.remove();
      }
    };
  }, []);

  // Paste link from Google Maps or search text
  const handlePasteFromClipboard = async () => {
    const text = await Clipboard.getStringAsync();
    if (!text) {
      Alert.alert(
        'Clipboard trống',
        'Hãy mở Google Maps -> bấm Chia sẻ (Share) -> Sao chép liên kết, rồi bấm lại nút này.'
      );
      return;
    }
    setSearchQuery(text);
    await handleSearchOrResolve(text);
  };

  // Resolve Google Maps URL, coordinates, or search query
  const handleSearchOrResolve = async (inputOverride?: string) => {
    const raw = (inputOverride ?? searchQuery).trim();
    if (!raw) return;

    Keyboard.dismiss();
    setLoading(true);
    setSuggestions([]);

    try {
      const parsed = await parseGoogleMapsInput(raw);

      if (parsed.coordinate) {
        await selectDestination(
          parsed.label || 'Điểm ghim Google Maps',
          parsed.coordinate
        );
      } else if (parsed.query) {
        const results = await searchPlaces(parsed.query);
        if (results.length === 0) {
          Alert.alert(
            'Không tìm thấy',
            'Không tìm thấy địa điểm này. Bạn có thể dán link chia sẻ hoặc tọa độ từ Google Maps.'
          );
        } else if (results.length === 1) {
          await selectDestination(results[0].shortName, results[0].coordinate);
        } else {
          setSuggestions(results);
        }
      }
    } catch (err: any) {
      Alert.alert('Lỗi tìm kiếm', err.message || 'Đã có lỗi xảy ra');
    } finally {
      setLoading(false);
    }
  };

  // Calculate route to selected destination
  const selectDestination = async (name: string, coord: Coordinate) => {
    setSuggestions([]);
    setLoading(true);
    try {
      let start = currentLocation;
      if (!start) {
        const loc = await Location.getCurrentPositionAsync({});
        start = {
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
        };
        setCurrentLocation(start);
      }

      const routeData = await fetchRoute(start, coord);
      setDestination({ name, coordinate: coord });
      setRoutePolyline(routeData.polyline);
      setSteps(routeData.steps);
      setTotalDistance(routeData.totalDistanceMeters);

      const firstTurnIdx = routeData.steps.length > 1 ? 1 : 0;
      setCurrentStepIdx(firstTurnIdx);
      if (routeData.steps[firstTurnIdx]) {
        setDistToNext(
          getDistanceMeters(start, routeData.steps[firstTurnIdx].maneuverLocation)
        );
      }

      if (mapRef.current && routeData.polyline.length > 1) {
        mapRef.current.fitToCoordinates(routeData.polyline, {
          edgePadding: { top: 120, right: 50, bottom: 260, left: 50 },
          animated: true,
        });
      }
    } catch (err: any) {
      Alert.alert('Lỗi tính đường đi', err.message || 'Không thể lấy lộ trình');
    } finally {
      setLoading(false);
    }
  };

  // Start navigation & background location tracking
  const startNavigation = async () => {
    if (!destination || steps.length === 0) return;

    const firstIdx = steps.length > 1 ? 1 : 0;
    const navState: PersistedNavState = {
      isActive: true,
      destinationName: destination.name,
      steps,
      currentStepIndex: firstIdx,
      lastUpdated: Date.now(),
    };
    await AsyncStorage.setItem(STORAGE_NAV_STATE_KEY, JSON.stringify(navState));
    setIsNavigating(true);
    setCurrentStepIdx(firstIdx);

    // Send initial notification to Redmi Watch 5
    const firstStep = steps[firstIdx];
    const dist =
      currentLocation && firstStep
        ? getDistanceMeters(currentLocation, firstStep.maneuverLocation)
        : firstStep?.distanceMeters || 0;

    await sendWatchNotification(
      `🛵 Bắt đầu: ${destination.name}`,
      firstStep
        ? `Tiếp theo (${formatDistance(dist)}): ${firstStep.arrowEmoji} ${firstStep.instruction}`
        : 'Đang dẫn đường...'
    );

    // Foreground high-accuracy watcher
    if (fgSubRef.current) {
      fgSubRef.current.remove();
    }
    fgSubRef.current = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        distanceInterval: 5,
        timeInterval: 2000,
      },
      async (loc) => {
        const coord = {
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
        };
        setCurrentLocation(coord);
        const res = await processLocationUpdate(coord);
        if (res.state) {
          setSteps(res.state.steps);
          setCurrentStepIdx(res.state.currentStepIndex);
          if (!res.state.isActive) {
            stopNavigation();
          }
        }
        if (res.distanceToNextTurn !== null) {
          setDistToNext(res.distanceToNextTurn);
        }
      }
    );

    // Request background location for locked screen mode (works in standalone .ipa / Dev build)
    try {
      const { status: bgStatus } =
        await Location.requestBackgroundPermissionsAsync();
      if (bgStatus === 'granted') {
        const isRegistered = await Location.hasStartedLocationUpdatesAsync(
          BACKGROUND_NAV_TASK
        );
        if (!isRegistered) {
          await Location.startLocationUpdatesAsync(BACKGROUND_NAV_TASK, {
            accuracy: Location.Accuracy.BestForNavigation,
            distanceInterval: 8,
            showsBackgroundLocationIndicator: true,
            pausesUpdatesAutomatically: false,
            activityType: Location.ActivityType.AutomotiveNavigation,
          });
        }
      }
    } catch {
      // Background task registration might be skipped in standard Expo Go sandbox
    }
  };

  // Stop navigation
  const stopNavigation = async () => {
    setIsNavigating(false);
    const raw = await AsyncStorage.getItem(STORAGE_NAV_STATE_KEY);
    if (raw) {
      const parsed: PersistedNavState = JSON.parse(raw);
      parsed.isActive = false;
      await AsyncStorage.setItem(STORAGE_NAV_STATE_KEY, JSON.stringify(parsed));
    }
    if (fgSubRef.current) {
      fgSubRef.current.remove();
      fgSubRef.current = null;
    }
    try {
      const started = await Location.hasStartedLocationUpdatesAsync(
        BACKGROUND_NAV_TASK
      );
      if (started) {
        await Location.stopLocationUpdatesAsync(BACKGROUND_NAV_TASK);
      }
    } catch {
      // ignore
    }
  };

  // Test notification button to verify Redmi Watch 5 vibration immediately
  const handleTestWatchNotification = async () => {
    const activeStep = steps[currentStepIdx];
    const title = activeStep
      ? `${activeStep.arrowEmoji} Sắp rẽ (70m)`
      : `➡️ Sắp rẽ (70m) [Test]`;
    const body = activeStep
      ? activeStep.instruction
      : `Rẽ phải vào Nguyễn Huệ (Test kết nối Redmi Watch 5)`;

    await sendWatchNotification(title, body);
    Alert.alert(
      'Đã bắn thông báo!',
      'Nếu bạn đang mở màn hình iPhone, hãy bấm nút Nguồn khóa màn hình ngay (hoặc tắt mục "Chỉ nhận khi khóa màn hình" trong app Mi Fitness) để thấy Redmi Watch 5 rung lên.'
    );
  };

  // Simulate next step for testing without riding outside
  const handleSimulateNextTurn = async () => {
    if (steps.length === 0) return;
    const step = steps[currentStepIdx] || steps[0];
    await sendWatchNotification(
      `${step.arrowEmoji} RẼ NGAY! (20m)`,
      `${step.instruction}`
    );
    if (currentStepIdx + 1 < steps.length) {
      setCurrentStepIdx(currentStepIdx + 1);
    }
  };

  const activeStep = steps[currentStepIdx];

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />

      {/* Top Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>⌚ Redmi Watch 5 Nav</Text>
          <Text style={styles.headerSubtitle}>
            Cầu nối Google Maps ➔ Thông báo Đồng hồ
          </Text>
        </View>
        <View style={styles.headerButtons}>
          <TouchableOpacity
            style={styles.testWatchBtn}
            onPress={handleTestWatchNotification}
          >
            <Text style={styles.testWatchBtnText}>🔔 Test Đồng hồ</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.helpBtn}
            onPress={() => setShowGuideModal(true)}
          >
            <Text style={styles.helpBtnText}>❓</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Search & Paste Google Maps Bar */}
      <View style={styles.searchSection}>
        <View style={styles.searchRow}>
          <TextInput
            style={styles.searchInput}
            placeholder="Dán link Google Maps hoặc nhập địa chỉ..."
            placeholderTextColor="#94a3b8"
            value={searchQuery}
            onChangeText={setSearchQuery}
            onSubmitEditing={() => handleSearchOrResolve()}
            returnKeyType="search"
          />
          <TouchableOpacity
            style={styles.searchGoBtn}
            onPress={() => handleSearchOrResolve()}
          >
            <Text style={styles.searchGoBtnText}>Tìm</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.quickActionRow}>
          <TouchableOpacity
            style={styles.pasteGmapBtn}
            onPress={handlePasteFromClipboard}
          >
            <Text style={styles.pasteGmapBtnText}>
              📋 Dán nhanh Link chia sẻ từ Google Maps
            </Text>
          </TouchableOpacity>
        </View>

        {loading && (
          <ActivityIndicator
            size="small"
            color="#38bdf8"
            style={{ marginTop: 8 }}
          />
        )}

        {/* Place Suggestions Dropdown */}
        {suggestions.length > 0 && (
          <View style={styles.suggestionsBox}>
            <FlatList
              data={suggestions}
              keyExtractor={(_, idx) => String(idx)}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.suggestionItem}
                  onPress={() =>
                    selectDestination(item.shortName, item.coordinate)
                  }
                >
                  <Text style={styles.suggestionTitle}>{item.shortName}</Text>
                  <Text style={styles.suggestionSub} numberOfLines={1}>
                    {item.displayName}
                  </Text>
                </TouchableOpacity>
              )}
            />
          </View>
        )}
      </View>

      {/* Map View */}
      <View style={styles.mapContainer}>
        <MapView
          ref={mapRef}
          style={styles.map}
          showsUserLocation
          followsUserLocation={isNavigating}
          onPress={(e) => {
            if (!isNavigating) {
              const coord = e.nativeEvent.coordinate;
              selectDestination('Điểm chọn trên bản đồ', coord);
            }
          }}
          initialRegion={{
            latitude: currentLocation?.latitude || 10.7769,
            longitude: currentLocation?.longitude || 106.7009,
            latitudeDelta: 0.04,
            longitudeDelta: 0.04,
          }}
        >
          {destination && (
            <Marker
              coordinate={destination.coordinate}
              title={destination.name}
              pinColor="#ef4444"
            />
          )}
          {routePolyline.length > 1 && (
            <Polyline
              coordinates={routePolyline}
              strokeWidth={5}
              strokeColor="#38bdf8"
            />
          )}
        </MapView>

        {/* Hint to tap anywhere on map */}
        {!destination && !isNavigating && (
          <View style={styles.mapHintBadge}>
            <Text style={styles.mapHintBadgeText}>
              👆 Chạm bất kỳ đâu trên bản đồ để chọn điểm đến
            </Text>
          </View>
        )}

        {/* Active Turn Banner Overlay */}
        {destination && activeStep && (
          <View style={styles.turnBanner}>
            <Text style={styles.turnEmoji}>{activeStep.arrowEmoji}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.turnDistText}>
                {distToNext !== null
                  ? `Còn ${formatDistance(distToNext)}`
                  : formatDistance(activeStep.distanceMeters)}
              </Text>
              <Text style={styles.turnInstruction} numberOfLines={2}>
                {activeStep.instruction}
              </Text>
            </View>
            {isNavigating && (
              <TouchableOpacity
                style={styles.simBtn}
                onPress={handleSimulateNextTurn}
              >
                <Text style={styles.simBtnText}>Bắn thử bước này ⌚</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>

      {/* Bottom Control Panel */}
      {destination && (
        <View style={styles.bottomCard}>
          <View style={styles.destInfoRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.destLabel}>Điểm đến:</Text>
              <Text style={styles.destName} numberOfLines={1}>
                {destination.name}
              </Text>
              <Text style={styles.destStats}>
                Tổng quãng đường: {formatDistance(totalDistance)} •{' '}
                {steps.length} chặng báo rẽ (200m / 70m / 20m)
              </Text>
            </View>
          </View>

          {!isNavigating ? (
            <TouchableOpacity
              style={styles.startNavBtn}
              onPress={startNavigation}
            >
              <Text style={styles.startNavBtnText}>
                🚀 BẮT ĐẦU DẪN ĐƯỜNG RA ĐỒNG HỒ
              </Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.stopNavBtn}
              onPress={stopNavigation}
            >
              <Text style={styles.stopNavBtnText}>⏹ DỪNG DẪN ĐƯỜNG</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Setup Guide Modal for Mi Fitness & Redmi Watch 5 */}
      <Modal visible={showGuideModal} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              ⚙️ Cài đặt để Redmi Watch 5 nhận chỉ đường
            </Text>
            <ScrollView style={{ maxHeight: 380 }}>
              <Text style={styles.modalStep}>
                1️⃣ <Text style={{ fontWeight: '700' }}>Trong app Mi Fitness (iPhone):</Text>
                {'\n'}• Vào tab <Text style={styles.highlight}>Thiết bị</Text> ➔{' '}
                <Text style={styles.highlight}>Thông báo ứng dụng</Text>.
                {'\n'}• Bật công tắc cho phép thông báo và kéo xuống dưới cùng bật mục{' '}
                <Text style={styles.highlight}>"Khác" (Other)</Text>.
                {'\n'}• Tắt mục{' '}
                <Text style={styles.highlight}>"Chỉ nhận khi khóa màn hình"</Text> nếu bạn muốn đồng hồ rung cả khi màn hình iPhone đang sáng.
              </Text>

              <Text style={styles.modalStep}>
                2️⃣ <Text style={{ fontWeight: '700' }}>Cài đặt Bluetooth iPhone:</Text>
                {'\n'}• Vào <Text style={styles.highlight}>Cài đặt iPhone ➔ Bluetooth</Text>.
                {'\n'}• Bấm chữ <Text style={styles.highlight}>(i)</Text> cạnh tên Redmi Watch 5 ➔ Bật{' '}
                <Text style={styles.highlight}>Chia sẻ thông báo hệ thống (Share System Notifications)</Text>.
              </Text>

              <Text style={styles.modalStep}>
                3️⃣ <Text style={{ fontWeight: '700' }}>Cách lấy điểm từ Google Maps:</Text>
                {'\n'}• Mở Google Maps chọn địa điểm ➔ Bấm nút{' '}
                <Text style={styles.highlight}>Chia sẻ (Share)</Text> ➔{' '}
                <Text style={styles.highlight}>Sao chép liên kết</Text>.
                {'\n'}• Mở ứng dụng này ➔ Bấm{' '}
                <Text style={styles.highlight}>"📋 Dán nhanh Link chia sẻ từ Google Maps"</Text> ➔ Bấm Bắt đầu!
              </Text>
            </ScrollView>

            <TouchableOpacity
              style={styles.closeModalBtn}
              onPress={() => setShowGuideModal(false)}
            >
              <Text style={styles.closeModalBtnText}>Đã hiểu</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
    paddingTop: Platform.OS === 'android' ? 28 : 0,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#1e293b',
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  headerTitle: {
    color: '#f8fafc',
    fontSize: 18,
    fontWeight: '800',
  },
  headerSubtitle: {
    color: '#38bdf8',
    fontSize: 12,
    marginTop: 2,
  },
  headerButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  testWatchBtn: {
    backgroundColor: '#0284c7',
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
  },
  testWatchBtnText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
  },
  helpBtn: {
    backgroundColor: '#334155',
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
  },
  helpBtnText: {
    fontSize: 13,
  },
  searchSection: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#1e293b',
    zIndex: 10,
  },
  searchRow: {
    flexDirection: 'row',
    gap: 8,
  },
  searchInput: {
    flex: 1,
    backgroundColor: '#0f172a',
    color: '#f8fafc',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#334155',
    fontSize: 14,
  },
  searchGoBtn: {
    backgroundColor: '#38bdf8',
    paddingHorizontal: 16,
    justifyContent: 'center',
    borderRadius: 8,
  },
  searchGoBtnText: {
    color: '#0f172a',
    fontWeight: '800',
    fontSize: 14,
  },
  quickActionRow: {
    marginTop: 8,
  },
  pasteGmapBtn: {
    backgroundColor: '#334155',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  pasteGmapBtnText: {
    color: '#e2e8f0',
    fontSize: 13,
    fontWeight: '600',
  },
  suggestionsBox: {
    marginTop: 8,
    backgroundColor: '#0f172a',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#334155',
    maxHeight: 200,
  },
  suggestionItem: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  suggestionTitle: {
    color: '#f8fafc',
    fontWeight: '700',
    fontSize: 14,
  },
  suggestionSub: {
    color: '#94a3b8',
    fontSize: 12,
    marginTop: 2,
  },
  mapContainer: {
    flex: 1,
    position: 'relative',
  },
  map: {
    flex: 1,
  },
  mapHintBadge: {
    position: 'absolute',
    bottom: 24,
    alignSelf: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.92)',
    paddingVertical: 9,
    paddingHorizontal: 16,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#38bdf8',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
  },
  mapHintBadgeText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '700',
  },
  turnBanner: {
    position: 'absolute',
    top: 12,
    left: 12,
    right: 12,
    backgroundColor: 'rgba(15, 23, 42, 0.94)',
    borderRadius: 12,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#38bdf8',
    gap: 12,
  },
  turnEmoji: {
    fontSize: 34,
  },
  turnDistText: {
    color: '#38bdf8',
    fontSize: 18,
    fontWeight: '800',
  },
  turnInstruction: {
    color: '#f8fafc',
    fontSize: 14,
    fontWeight: '600',
    marginTop: 2,
  },
  simBtn: {
    backgroundColor: '#0284c7',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
  },
  simBtnText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  bottomCard: {
    backgroundColor: '#1e293b',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: '#334155',
  },
  destInfoRow: {
    marginBottom: 12,
  },
  destLabel: {
    color: '#94a3b8',
    fontSize: 12,
  },
  destName: {
    color: '#f8fafc',
    fontSize: 16,
    fontWeight: '800',
    marginTop: 2,
  },
  destStats: {
    color: '#38bdf8',
    fontSize: 12,
    marginTop: 4,
  },
  startNavBtn: {
    backgroundColor: '#10b981',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  startNavBtnText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '800',
  },
  stopNavBtn: {
    backgroundColor: '#ef4444',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  stopNavBtnText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '800',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    padding: 20,
  },
  modalCard: {
    backgroundColor: '#1e293b',
    borderRadius: 14,
    padding: 18,
    borderWidth: 1,
    borderColor: '#334155',
  },
  modalTitle: {
    color: '#f8fafc',
    fontSize: 17,
    fontWeight: '800',
    marginBottom: 12,
  },
  modalStep: {
    color: '#cbd5e1',
    fontSize: 14,
    lineHeight: 21,
    marginBottom: 14,
  },
  highlight: {
    color: '#38bdf8',
    fontWeight: '700',
  },
  closeModalBtn: {
    backgroundColor: '#38bdf8',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 6,
  },
  closeModalBtnText: {
    color: '#0f172a',
    fontWeight: '800',
    fontSize: 15,
  },
});
