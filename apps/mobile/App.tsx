import { fetch as expoFetch } from 'expo/fetch'
import * as SecureStore from 'expo-secure-store'
import { useShareIntent } from 'expo-share-intent'
import { StatusBar } from 'expo-status-bar'
import { useEffect, useState } from 'react'
import { Button, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { checkServer, type ServerStatus } from './check'
import { linkFrom, saveLink } from './share'
import { type Chunk, streamAsk } from './stream'

const URL_KEY = 'serverUrl'
const TOKEN_KEY = 'captureToken'
// The scratch SSE script (plan ruling E3): 20 events 100 ms apart, for when the
// scratch Kothai has AI off and /api/ask answers 409 instead of streaming.
const SCRATCH_SSE = 'http://localhost:5198/'

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
  const { hasShareIntent, shareIntent, resetShareIntent, error: shareError } = useShareIntent()
  const [shared, setShared] = useState<string | null>(null)
  const [shareMessage, setShareMessage] = useState('')
  const [canRetry, setCanRetry] = useState(false)
  const [question, setQuestion] = useState('What have I saved?')
  const [useScratch, setUseScratch] = useState(false)
  const [chunks, setChunks] = useState<Chunk[]>([])
  const [askStatus, setAskStatus] = useState('')

  useEffect(() => {
    if (!hasShareIntent) return
    const link = linkFrom(shareIntent)
    // Clearing the intent is what stops a later re-render saving this share twice.
    resetShareIntent()
    setShared(link)
    if (link) saveShared(link)
    else {
      setCanRetry(false)
      setShareMessage('Kothai saves links')
    }
  }, [hasShareIntent])

  // A share the native module could not read never sets hasShareIntent.
  useEffect(() => {
    if (shareError) setShareMessage(`Could not read the share: ${shareError}`)
  }, [shareError])

  // Reads the settings from SecureStore, not from state: a share can cold-start
  // the app before the load effect above has filled the fields in.
  async function saveShared(link: string) {
    setCanRetry(false)
    setShareMessage(`Saving ${link}…`)
    try {
      const [baseUrl, token] = await Promise.all([SecureStore.getItemAsync(URL_KEY), SecureStore.getItemAsync(TOKEN_KEY)])
      if (!baseUrl) {
        setShareMessage('Set the server URL and capture token first, then Retry.')
        setCanRetry(true)
        return
      }
      const outcome = await saveLink(link, { baseUrl, token: token || undefined }, expoFetch)
      if (outcome.kind === 'saved') setShareMessage(`Saved: ${outcome.title}`)
      else {
        setShareMessage(`Not saved (${outcome.code}): ${outcome.message}`)
        setCanRetry(true)
      }
    } catch (e) {
      setShareMessage(`Not saved: ${String(e)}`)
      setCanRetry(true)
    }
  }

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

  // No token: Ask needs a session, which a capture token cannot give, so this
  // runs against a scratch server with no password (plan ruling E3).
  async function ask() {
    setChunks([])
    setAskStatus('Asking…')
    const target = useScratch ? SCRATCH_SSE : `${url.trim().replace(/\/+$/, '')}/api/ask`
    try {
      const status = await streamAsk(target, question, expoFetch, (c) => setChunks((prev) => [...prev, c]))
      setAskStatus(`Done, HTTP ${status}`)
    } catch (e) {
      setAskStatus(`Ask failed: ${String(e)}`)
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
        {shareMessage ? <Text testID="share-status">{shareMessage}</Text> : null}
        {canRetry && shared ? <Button title="Retry" onPress={() => saveShared(shared)} /> : null}
        <Text style={styles.title}>Ask test</Text>
        <TextInput style={styles.input} value={question} onChangeText={setQuestion} />
        <View style={styles.row}>
          <Switch value={useScratch} onValueChange={setUseScratch} />
          <Text>{useScratch ? `Scratch SSE ${SCRATCH_SSE}` : 'Server /api/ask'}</Text>
        </View>
        <Button title="Ask" onPress={ask} />
        <Text testID="ask-status">{askStatus}</Text>
        {chunks.map((c, i) => (
          <Text key={i} style={styles.chunk}>
            {`+${c.ms}ms ${c.text.trim()}`}
          </Text>
        ))}
      <StatusBar style="auto" />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
  body: { padding: 20, gap: 8 },
  title: { fontSize: 24, fontWeight: '600', marginBottom: 8 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 6, padding: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chunk: { fontFamily: 'Menlo', fontSize: 12 },
})
