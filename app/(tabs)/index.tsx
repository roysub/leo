import { GoogleGenerativeAI, SchemaType, type ResponseSchema } from '@google/generative-ai';
import { useCallback, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { supabase } from '@/lib/supabase';

const MOOD_PROMPT =
  'Analyze this journal entry and return a JSON object with only two keys: "emoji" (one emoji) and "color" (a hex code for a soft pastel background that matches the mood).';

const MOOD_RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    emoji: {
      type: SchemaType.STRING,
      description: 'Exactly one emoji for the mood',
    },
    color: {
      type: SchemaType.STRING,
      description: 'Hex color for a soft pastel background',
    },
  },
  required: ['emoji', 'color'],
};

function getPropCI(o: Record<string, unknown>, ...candidates: string[]): unknown {
  const keys = Object.keys(o);
  for (const name of candidates) {
    const target = name.toLowerCase();
    const key = keys.find((k) => k.toLowerCase() === target);
    if (key !== undefined) {
      return o[key];
    }
  }
  return undefined;
}

function coerceMoodFields(emoji: unknown, color: unknown): { emoji: string; color: string } | null {
  if (emoji == null || color == null) {
    return null;
  }
  const e = typeof emoji === 'string' ? emoji.trim() : String(emoji).trim();
  const c = typeof color === 'string' ? color.trim() : String(color).trim();
  if (!e || !c) {
    return null;
  }
  return { emoji: e, color: c };
}

function extractMoodFromParsed(parsed: unknown): { emoji: string; color: string } | null {
  if (parsed == null) {
    return null;
  }
  if (Array.isArray(parsed) && parsed.length > 0) {
    return extractMoodFromParsed(parsed[0]);
  }
  if (typeof parsed !== 'object') {
    return null;
  }
  const o = parsed as Record<string, unknown>;
  const direct = coerceMoodFields(
    o.emoji ?? getPropCI(o, 'emoji'),
    o.color ?? getPropCI(o, 'color', 'colour'),
  );
  if (direct) {
    return direct;
  }
  const nested = o.mood ?? o.result ?? o.response ?? o.data;
  if (nested && typeof nested === 'object') {
    const n = nested as Record<string, unknown>;
    const fromNested = coerceMoodFields(
      n.emoji ?? getPropCI(n, 'emoji'),
      n.color ?? getPropCI(n, 'color', 'colour'),
    );
    if (fromNested) {
      return fromNested;
    }
  }
  return null;
}

function parseMoodFromResponse(text: string): { emoji: string; color: string } | null {
  const trimmed = text.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const jsonSlice = trimmed.match(/\{[\s\S]*\}/);
    if (!jsonSlice) {
      return null;
    }
    try {
      parsed = JSON.parse(jsonSlice[0]);
    } catch {
      return null;
    }
  }
  return extractMoodFromParsed(parsed);
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export default function HomeScreen() {
  const [feeling, setFeeling] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  /** Synchronous guard — state `isSaving` is not updated until after a frame, so this blocks double-taps. */
  const saveInFlightRef = useRef(false);

  // Gemini and Supabase run only here; this handler is attached exclusively to the Save button.
  const handleSave = useCallback(async () => {
    if (!feeling.trim() || isSaving || saveInFlightRef.current) {
      return;
    }

    const journalText = feeling.trim();
    saveInFlightRef.current = true;
    setIsSaving(true);

    const apiKey = process.env.EXPO_PUBLIC_GEMINI_API_KEY;
    if (!apiKey) {
      const msg =
        'EXPO_PUBLIC_GEMINI_API_KEY is missing. Add it to .env, stop Expo (Ctrl+C), then run `npx expo start` again.';
      console.warn('[save]', msg);
      Alert.alert('Missing API key', msg);
      saveInFlightRef.current = false;
      setIsSaving(false);
      return;
    }

    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({
        model: 'gemini-2.5-flash-lite',
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: MOOD_RESPONSE_SCHEMA,
        },
      });

      const prompt = `${MOOD_PROMPT}\n\nJournal entry:\n${journalText}`;
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();

      console.warn('--- AI RESPONSE START ---');
      console.warn(text);
      console.warn('--- AI RESPONSE END ---');

      const mood = parseMoodFromResponse(text);

      if (!mood) {
        const detail = text.length > 200 ? `${text.slice(0, 200)}…` : text;
        console.warn('[save] Parse failed. Raw:', text);
        Alert.alert('Could not read AI reply', `Expected JSON with emoji and color.\n\nFirst part:\n${detail}`);
        return;
      }

      const moodEmoji = `${mood.emoji}`.trim();
      const moodColor = `${mood.color}`.trim();
      if (!moodEmoji || !moodColor) {
        console.warn('[save] Empty mood fields:', mood);
        Alert.alert('Invalid mood', 'AI returned empty emoji or color.');
        return;
      }

      const row = {
        content: journalText,
        mood_emoji: moodEmoji,
        mood_color: moodColor,
      };
      const serialized = JSON.stringify(row);
      console.warn('[save] Insert payload JSON:', serialized);
      if (!serialized.includes('"mood_emoji"') || !serialized.includes('"mood_color"')) {
        console.warn('[save] Payload missing mood keys:', row);
        Alert.alert('Save bug', 'Mood fields were not included in the insert payload.');
        return;
      }

      const { data, error } = await supabase
        .from('main')
        .insert([row])
        .select('content, mood_emoji, mood_color');

      if (error) {
        console.warn('[save] Supabase error:', error);
        let hint = '';
        if (
          error.message?.includes('column') ||
          error.code === 'PGRST204' ||
          error.code === '42703'
        ) {
          hint =
            '\n\nCheck that table `main` has columns `mood_emoji` and `mood_color` (snake_case).';
        }
        if (error.code === '42501') {
          hint =
            '\n\nRow Level Security blocked this insert. In Supabase: add an INSERT policy for `main`, or sign in if rows must match auth.uid().';
        }
        Alert.alert('Could not save', `${error.message ?? 'Unknown error'} (${error.code ?? 'no code'})${hint}`);
      } else {
        console.warn('[save] Success:', data);
        const row0 = Array.isArray(data) ? data[0] : data;
        Alert.alert(
          'Saved',
          row0
            ? `Entry saved with ${String(row0.mood_emoji ?? '?')} and color ${String(row0.mood_color ?? '?')}.`
            : 'Entry saved.',
        );
        setFeeling('');
      }
    } catch (err) {
      console.warn('[save] Gemini / network error:', err);
      Alert.alert('Request failed', formatError(err));
    } finally {
      saveInFlightRef.current = false;
      setIsSaving(false);
    }
  }, [feeling, isSaving]);

  return (
    <View style={styles.container}>
      <Text style={styles.label}>How are you feeling?</Text>
      <TextInput
        style={styles.input}
        value={feeling}
        onChangeText={setFeeling}
        placeholder="Type your feeling..."
        editable={!isSaving}
      />

      <Pressable
        style={({ pressed }) => [
          styles.button,
          (pressed || isSaving) && styles.buttonPressed,
        ]}
        onPress={() => {
          void handleSave();
        }}
        disabled={isSaving}>
        <Text style={styles.buttonText}>
          {isSaving ? 'Saving...' : 'Save Entry'}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 40,
    backgroundColor: '#fff',
  },
  label: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 12,
  },
  input: {
    width: '100%',
    minHeight: 48,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 10,
    paddingHorizontal: 14,
    fontSize: 16,
    marginBottom: 16,
  },
  button: {
    backgroundColor: '#2563EB',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
