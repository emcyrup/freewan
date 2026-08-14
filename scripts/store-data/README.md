# 店舗ごとの初期データ

`seed-menus.js` / `seed-plans.js` の `--file=` で渡す JSON。
コードを店舗ごとに書き換えないための置き場所（docs/new-store.md の方針）。

```bash
docker compose exec app node scripts/seed-menus.js --file=scripts/store-data/freewan.menus.json
docker compose exec app node scripts/seed-plans.js --file=scripts/store-data/freewan.plans.json
```

## freewan（FREE WAN 大阪北区店）

- メニューの所要時間は**モック段階の仮値**。Phase 1 のヒアリングで実値に直す
  （直す場合はこの JSON を編集して再実行。同名はスキップされるため、
  名前を変えた場合は管理画面で旧メニューを非表示にする）
- 2026-08-14 に「幼稚園（スクール）」を **「ペットスクール」** へ改称し、「一時預かり」を削除した。
  投入済みの DB には反映されない（seed は同名スキップ・削除もしない）ため、
  **管理画面のメニュー編集で旧名を改称し、一時預かりを無効にする**こと。
  予約の `menu` は登録時点の名前のコピーなので、改称しても過去の履歴は変わらない。
  ただし回数消化はメニュー名で引くため、改称前に入っている**先の予約は改称後の名前に直す**
- コース名は北区店の呼び方「スクール 月4会員 / 月8会員」。繰越は1ヶ月
  （当月優先消化・繰越1ヶ月の運用ルールは docs/handover.md「店舗へ確認したい運用ルール」参照）
- 料金は犬種によって変わるためメニューには持たせない（ここっとベールと同じ方針）

## 追加するとき

`<店舗名>.menus.json` / `<店舗名>.plans.json` の対で増やす。
実在の顧客情報（氏名・電話番号）はこのディレクトリに置かないこと。
