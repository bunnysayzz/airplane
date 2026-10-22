import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { registerRootComponent } from 'expo';

// Diagnostic entry point (branch diag/hello-world-release only):
// bare Hello World, no app code, no expo-router — used to bisect whether
// the app's JS triggers the silent quit in release builds.
function App() {
  return (
    <View style={styles.container}>
      <Text>Hello World</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

registerRootComponent(App);

export default App;
