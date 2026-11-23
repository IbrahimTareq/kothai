import { fetch as expoFetch } from 'expo/fetch'
import * as SecureStore from 'expo-secure-store'
import { StatusBar } from 'expo-status-bar'
import { useEffect, useState } from 'react'
import { Button, ScrollView, StyleSheet, Text, TextInput } from 'react-native'
import { checkServer, type ServerStatus } from './check'

const URL_KEY = 'serverUrl'
const TOKEN_KEY = 'captureToken'

function describe(s: ServerStatus): string {
  switch (s.kind) {
    case 'ok':
      return `Connected. API ${s.apiVersion}, sign-in: ${s.signIn.join(', ')}`
    case 'update-server':
      return `Update your server (${s.detail})`
    case 'update-app':
      return `Update the app (${s.detail})`
    case 'unreachable':
      return `Can't reach server (${s.detail})`
  }
}

export default function App() {
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    Promise.all([SecureStore.getItemAsync(URL_KEY), SecureStore.getItemAsync(TOKEN_KEY)])
      .then(([u, t]) => {
        setUrl(u ?? '')
        setToken(t ?? '')
      })
      .catch((e) => setMessage(`Could not read saved settings: ${String(e)}`))
  }, [])

  async function save() {
    try {
      await SecureStore.setItemAsync(URL_KEY, url.trim())
      await SecureStore.setItemAsync(TOKEN_KEY, token.trim())
      setMessage('Saved.')
    } catch (e) {
      setMessage(`Could not save: ${String(e)}`)
    }
  }

  async function check() {
    setMessage('Checking…')
    try {
      setMessage(describe(await checkServer(url.trim(), expoFetch)))
    } catch (e) {
      setMessage(`Check failed: ${String(e)}`)
    }
  }

  return (
    // contentInsetAdjustmentBehavior keeps the screen clear of the notch:
    // React Native's SafeAreaView is deprecated and logs a warning on every load.
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.body}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
    >
        <Text style={styles.title}>Kothai</Text>
        <Text>Server URL</Text>
        <TextInput
          style={styles.input}
          value={url}
          onChangeText={setUrl}
          placeholder="http://localhost:5199"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <Text>Capture token</Text>
        <TextInput
          style={styles.input}
          value={token}
          onChangeText={setToken}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
        <Button title="Save" onPress={save} />
        <Button title="Check server" onPress={check} />
        <Text testID="status">{message}</Text>
      <StatusBar style="auto" />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
  body: { padding: 20, gap: 8 },
  title: { fontSize: 24, fontWeight: '600', marginBottom: 8 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 6, padding: 10 },
})
