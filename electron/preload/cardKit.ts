/** 卡片可选组件样式；只作用于 infos-kit 命名空间，正文由角色编写。 */
import cardKitStyle from './cardKit.css?raw'

export function installCardKit(): void {
  const style = document.createElement('style')
  style.textContent = cardKitStyle
  document.documentElement.append(style)
}
