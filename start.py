#!/usr/bin/env python3
import subprocess
import sys
import os

def main():
    try:
        print("正在启动小米摄像头录像查看器...")
        print("按 Ctrl+C 停止服务")
        print("-" * 50)
        
        # 检查 package.json 中的 start 命令
        subprocess.run(["node", "server.js"], cwd=os.path.dirname(os.path.abspath(__file__)))
    except KeyboardInterrupt:
        print("\n服务已停止")
    except FileNotFoundError:
        print("错误: 未找到 node 命令，请确保已安装 Node.js")
        sys.exit(1)
    except Exception as e:
        print(f"启动失败: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
