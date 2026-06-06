#!/usr/bin/env python3
import os
import sys
from pathlib import Path

def count_chars_in_directory(directory):
    total_chars = 0
    file_count = 0
    text_extensions = {
        '.kt', '.java', '.js', '.py', '.json', '.xml', '.gradle', 
        '.properties', '.md', '.txt', '.gitignore', '.pro', '.yml', '.yaml'
    }
    binary_extensions = {'.p12', '.class', '.jar', '.apk', '.exe', '.dll', '.so', '.png', '.jpg', '.jpeg', '.ico', '.icns'}
    
    for root, dirs, files in os.walk(directory):
        for file in files:
            filepath = os.path.join(root, file)
            ext = os.path.splitext(file)[1].lower()
            
            # 跳过二进制文件
            if ext in binary_extensions:
                continue
                
            # 只统计文本文件，如果扩展名不在列表中，尝试判断是否为文本
            if ext in text_extensions or ext == '':
                try:
                    with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                        content = f.read()
                        chars = len(content)
                        total_chars += chars
                        file_count += 1
                        if chars > 10000:
                            print(f"  {filepath}: {chars:,} 字符")
                except Exception as e:
                    # 如果读取失败，可能是二进制文件
                    pass
                    
    return total_chars, file_count

if __name__ == "__main__":
    target_dir = r"C:\Users\EDY\Music\7.0bug"
    if not os.path.exists(target_dir):
        print(f"目录不存在: {target_dir}")
        sys.exit(1)
        
    print(f"正在统计目录: {target_dir}")
    total_chars, file_count = count_chars_in_directory(target_dir)
    
    print(f"\n统计结果:")
    print(f"  文件数量: {file_count}")
    print(f"  总字符数: {total_chars:,}")
    print(f"  约 {total_chars/1000:.1f} 千字符")
    print(f"  约 {total_chars/1000000:.3f} 百万字符")