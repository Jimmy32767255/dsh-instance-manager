// 版本记录。
//
// 三个位置共同承载版本，只有保持一致才有意义：
//   - package.json        npm 发布的内容
//   - lib/shared.js       运行中的面板上报的版本
//   - docs/CHANGELOG.md   publish.yml 据此生成发布说明
// 前两者不一致会在打 tag 时让 CI 失败；第三处不一致不会让任何检查失败，只会悄悄
// 发布一份除了“Release x.y.z”之外没有内容的说明。本测试让三处都显式暴露。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { VERSION } from '../lib/shared.js'

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8')

test('VERSION stays in lockstep with package.json', () => {
  const pkg = JSON.parse(read('../package.json'))
  assert.equal(VERSION, pkg.version)
})

test('both CHANGELOGs contain the version being shipped', () => {
  // 只要求存在，不要求位置：publish.yml 从匹配 PKG_VERSION 的标题开始收集，标题上方
  // 的 `## Unreleased` 不影响结果。真正会破坏发布的是完全没有匹配分节——说明为空。
  const heading = new RegExp(`^## ${VERSION.replace(/\./g, '\\.')}(\\s|$)`)
  for (const file of ['../docs/CHANGELOG.md', '../docs/CHANGELOG.en.md']) {
    const sections = read(file).split('\n').filter((line) => line.startsWith('## '))
    assert.ok(
      sections.some((line) => heading.test(line)),
      `${file} has no ${VERSION} section; publish.yml would cut empty release notes`
    )
  }
})
