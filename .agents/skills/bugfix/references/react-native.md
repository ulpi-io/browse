# React Native Bug Patterns

> Detect: `package.json` has `react-native` or `expo` dependency, `app.json`/`app.config.js` present, `.tsx` files with `View`/`Text`/`StyleSheet` imports.

## All React Bugs Apply

React Native inherits ALL React bug patterns (hooks, stale closures, key props, race conditions). See `react.md`. This file covers **native-specific** bugs only.

## Platform-Specific Bugs

### Platform differences — code that works on iOS but crashes on Android (or vice versa)

```tsx
// BUG: Shadow styles only work on iOS
const styles = StyleSheet.create({
  card: {
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    // Missing Android elevation
  },
});

// FIX: Use elevation for Android
const styles = StyleSheet.create({
  card: {
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 4,
      },
      android: {
        elevation: 4,
      },
    }),
  },
});
```

### Text must be inside Text component

```tsx
// BUG: Crashes on Android — raw text outside <Text>
function Label() {
  return <View>Hello World {/* crash on Android */}</View>;
}

// FIX: Always wrap text in <Text>
function Label() {
  return (
    <View>
      <Text>Hello World</Text>
    </View>
  );
}
```

## Navigation Bugs

### Memory leaks — screens stay mounted in stack

```tsx
// BUG: Timer/subscription not cleaned up — screen is still mounted in stack
function ChatScreen() {
  useEffect(() => {
    const ws = new WebSocket(url);
    ws.onmessage = handleMessage;
    // Missing cleanup — WebSocket stays open when navigating away
  }, []);
}

// FIX: Clean up on unmount (or use useFocusEffect for navigation-aware cleanup)
import { useFocusEffect } from "@react-navigation/native";

function ChatScreen() {
  useFocusEffect(
    useCallback(() => {
      const ws = new WebSocket(url);
      ws.onmessage = handleMessage;
      return () => ws.close();
    }, []),
  );
}
```

### Navigation params — stale params on re-navigation

```tsx
// BUG: Params from previous navigation persist
navigation.navigate("Profile", { userId: "1" });
// Later:
navigation.navigate("Profile"); // userId is still "1" from last time!

// FIX: Always pass all required params
navigation.navigate("Profile", { userId: newUserId });
// Or use navigation.push() to create a new screen instance
navigation.push("Profile", { userId: newUserId });
```

## Performance Bugs

### FlatList — missing keyExtractor or non-unique keys

```tsx
// BUG: No keyExtractor → uses index → stale items on update
<FlatList data={items} renderItem={({ item }) => <Item data={item} />} />

// FIX: Provide stable keyExtractor
<FlatList
  data={items}
  keyExtractor={(item) => item.id}
  renderItem={({ item }) => <Item data={item} />}
/>
```

### FlatList — inline functions cause re-renders

```tsx
// BUG: New function reference every render → all items re-render
<FlatList
  data={items}
  renderItem={({ item }) => (
    <Item data={item} onPress={() => handlePress(item.id)} />
  )}
/>;

// FIX: Memoize renderItem and use useCallback
const renderItem = useCallback(
  ({ item }) => <Item data={item} onPress={handlePress} />,
  [handlePress],
);
<FlatList data={items} renderItem={renderItem} />;
```

### Large images — no resizing before display

```tsx
// BUG: Full-resolution image loaded for a 50x50 thumbnail
<Image source={{ uri: user.avatarUrl }} style={{ width: 50, height: 50 }} />;

// FIX: Use image CDN resizing or FastImage with caching
import FastImage from "react-native-fast-image";
<FastImage
  source={{
    uri: `${user.avatarUrl}?w=100&h=100`,
    priority: FastImage.priority.normal,
  }}
  style={{ width: 50, height: 50 }}
/>;
```

## Async Storage / State Persistence

```tsx
// BUG: Not handling AsyncStorage failures (storage can be full)
const loadSettings = async () => {
  const data = await AsyncStorage.getItem("settings");
  setSettings(JSON.parse(data!)); // data could be null!
};

// FIX: Handle null and parse errors
const loadSettings = async () => {
  try {
    const data = await AsyncStorage.getItem("settings");
    if (data) setSettings(JSON.parse(data));
  } catch {
    // Storage read failed — use defaults
  }
};
```

## Permissions & Native APIs

```tsx
// BUG: Using camera without checking permissions
const takePhoto = async () => {
  const result = await ImagePicker.launchCameraAsync(); // crashes if no permission
};

// FIX: Request permission first
const takePhoto = async () => {
  const { status } = await Camera.requestCameraPermissionsAsync();
  if (status !== "granted") {
    Alert.alert("Permission needed", "Camera access is required");
    return;
  }
  const result = await ImagePicker.launchCameraAsync();
};
```

## Testing Patterns

```tsx
import { render, fireEvent, waitFor } from "@testing-library/react-native";

describe("ProfileScreen", () => {
  it("should handle missing navigation params gracefully", () => {
    const { getByText } = render(
      <ProfileScreen route={{ params: {} }} navigation={mockNavigation} />,
    );
    expect(getByText("User not found")).toBeTruthy();
  });

  it("should clean up WebSocket on unmount", () => {
    const closeSpy = vi.fn();
    vi.spyOn(global, "WebSocket").mockImplementation(() => ({
      close: closeSpy,
    }));
    const { unmount } = render(<ChatScreen />);
    unmount();
    expect(closeSpy).toHaveBeenCalled();
  });
});
```

## Framework Gotchas

| Gotcha                                  | Detail                                                       |
| --------------------------------------- | ------------------------------------------------------------ |
| No CSS, only StyleSheet/inline          | No cascading, no pseudo-selectors, no media queries          |
| `overflow: hidden` clips on Android     | Required for `borderRadius` to work                          |
| `zIndex` only works on iOS by default   | Android needs `elevation` for z-ordering                     |
| `TextInput` multiline behavior differs  | Android adds extra padding, iOS doesn't                      |
| Hot reload loses state                  | `useState` initializer re-runs on reload                     |
| Hermes vs JSC differences               | `Intl`, `RegExp` features may differ between engines         |
| `console.log` in production kills perf  | Remove or use `__DEV__` guard                                |
| Keyboard avoidance is platform-specific | Use `KeyboardAvoidingView` with `behavior` prop per platform |
