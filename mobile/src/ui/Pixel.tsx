import { ReactNode } from 'react';
import { Platform, Pressable, StyleProp, StyleSheet, Text, TextInput, TextStyle, View, ViewStyle } from 'react-native';
import { spritePalette, spriteRows, SPRITE_W, type Special } from '../sprites';
import { C, DOT } from '../theme';

/* 住人の絵を View で描く。1 ドット 1 View だと数百枚になるので、
   同じ色の続きを 1 枚にまとめる（行ごとのランレングス）。 */
export function PixelSprite({ title, special, dot = 3, crop = 'full' }: {
  title: string; special?: Special; dot?: number; crop?: 'full' | 'head';
}) {
  const rows = spriteRows(title, special);
  const pal = spritePalette(title, special);
  const slice = crop === 'head' ? rows.slice(1, 14) : rows;
  return (
    <View style={{ width: SPRITE_W * dot, height: slice.length * dot }}>
      {slice.map((row, j) => {
        const runs: { x: number; w: number; c: string }[] = [];
        for (let i = 0; i < row.length; i++) {
          const c = pal[row[i]];
          if (!c) continue;
          const last = runs[runs.length - 1];
          if (last && last.c === c && last.x + last.w === i) last.w += 1;
          else runs.push({ x: i, w: 1, c });
        }
        return runs.map((r, k) => (
          <View key={`${j}-${k}`} style={{
            position: 'absolute', left: r.x * dot, top: j * dot, width: r.w * dot, height: dot, backgroundColor: r.c,
          }} />
        ));
      })}
    </View>
  );
}

/* 窓。カードで囲まない方針だが、ゲームの「ウィンドウ」として 2px の枠だけ引く。
   accent を付けると上辺が琥珀になる（あなたの番のときだけ）。 */
export function Frame({ children, accent, style }: { children: ReactNode; accent?: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[f.frame, accent && f.accent, style]}>
      {children}
    </View>
  );
}

export function PixButton({ label, onPress, tone = 'plain', disabled, style, wide }: {
  label: string; onPress: () => void; tone?: 'plain' | 'amber' | 'danger' | 'ghost';
  disabled?: boolean; style?: StyleProp<ViewStyle>; wide?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={4}
      style={({ pressed }) => [
        f.btn, f[tone], wide && f.wide, pressed && f.pressed, disabled && f.disabled, style,
      ]}
    >
      <Text style={[f.btnText, tone === 'amber' && { color: C.amber }, tone === 'danger' && { color: C.dead },
        tone === 'ghost' && { color: C.dim }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/* 一部だけ選んでコピーできる文字。iOS の Text は selectable でも全文しか選べないので、
   編集できない TextInput で出す（範囲選択とコピーのメニューが付く）。Android は Text で足りる。 */
export function SelectableText({ text, style }: { text: string; style?: StyleProp<TextStyle> }) {
  if (Platform.OS === 'ios') {
    return (
      <TextInput
        value={text}
        editable={false}
        multiline
        scrollEnabled={false}
        style={[{ padding: 0, margin: 0 }, style]}
      />
    );
  }
  return <Text style={style} selectable>{text}</Text>;
}

export function Label({ children, color }: { children: ReactNode; color?: string }) {
  return <Text style={[f.label, color ? { color } : null]}>{children}</Text>;
}

export function TopBar({ left, title, right }: { left?: ReactNode; title?: ReactNode; right?: ReactNode }) {
  return (
    <View style={f.top}>
      <View style={f.topSide}>{left}</View>
      <View style={f.topMid}>{title}</View>
      <View style={[f.topSide, { alignItems: 'flex-end' }]}>{right}</View>
    </View>
  );
}

const f = StyleSheet.create({
  frame: { borderWidth: 2, borderColor: C.frameLo, backgroundColor: C.panel },
  accent: { borderTopColor: C.amber, borderTopWidth: 3 },
  btn: {
    borderWidth: 2, borderColor: C.frameLo, backgroundColor: C.panel,
    paddingVertical: 9, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', minHeight: 40,
  },
  wide: { flex: 1 },
  plain: {},
  ghost: { borderColor: 'transparent', backgroundColor: 'transparent' },
  amber: { borderColor: C.amber, backgroundColor: C.amberSoft },
  danger: { borderColor: C.dead },
  pressed: { backgroundColor: C.raised, transform: [{ translateY: 1 }] },
  disabled: { opacity: 0.35 },
  btnText: { color: C.text, fontFamily: DOT, fontSize: 15 },
  label: { color: C.faint, fontFamily: DOT, fontSize: 12, letterSpacing: 1 },
  top: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, height: 44 },
  topSide: { width: 92, justifyContent: 'center' },
  topMid: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
