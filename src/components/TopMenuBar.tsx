const menuItems = ["文件", "编辑", "视图", "帮助"];

export function TopMenuBar() {
  return (
    <header className="top-menu-bar">
      <div className="top-menu-brand">
        <span className="top-menu-brand-dot" />
        <div className="top-menu-brand-copy">
          <strong>戏曲多轨标注工作台</strong>
          <span>Desktop Web Workspace</span>
        </div>
      </div>
      <nav className="top-menu-items" aria-label="应用菜单">
        {menuItems.map((item) => (
          <button key={item} type="button" className="top-menu-button">
            {item}
          </button>
        ))}
      </nav>
      <div className="top-menu-status">研究标注环境</div>
    </header>
  );
}
